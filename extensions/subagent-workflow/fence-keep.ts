/**
 * What keeps a fenced session's subagents from carrying code past the
 * fence.
 *
 * A subagent's pi runs outside the fence its own commands run in, and
 * an extension it loads runs there too, as the person. So when the
 * children are fenced, the model may not name an extension a fenced
 * command could have written: only one in the current version of a
 * package pi has installed, which the fence holds read-only
 * (`fence-home.ts`). Not this package's own folder, since a session
 * reloaded onto a worktree runs from a tree its commands may write, and
 * not an older installed version, which may lack a fix the current one
 * has. An unfenced session's commands already run as the person, so its
 * children load what they are told, as before.
 *
 * Each named path is followed to where it really lies, and the child is
 * handed that, so a link swapped between this check and the start can't
 * point it somewhere else. A folder's own `.pi` is kept out another way:
 * a fenced session's children start ignoring project-local files.
 *
 * And a fenced session's subagents are fenced too. The fence holds a
 * pi's commands through this package's own bash, which an isolated
 * child, started without extensions, would never load: its bash would
 * be pi's plain one, run as the person. So each child of a fenced
 * session, or each child once subagents join the fence's first stage, is
 * told its sandbox by name, since a session the first stage lists has
 * none in its environment to pass on, and an isolated one loads the
 * fence's bash and file guards from the install, held as a named one is.
 * A session whose harness was loaded from the Nix store, as a room's is,
 * takes them from that same store copy instead: only that one, since
 * anyone may add a store path through the Nix daemon, and the store
 * keeps every older copy until it is collected.
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	askedSandbox,
	spawnsJoin,
} from "../../lib/internal/fence/fence-stage.ts";
import {
	canChange,
	heldStoreCopy,
	inside,
	installedPackages,
	NIX_STORE,
	packageRoot,
	settingsHarness,
	unchangeable,
} from "../../lib/internal/fence/installed-only.ts";
import { installOfVersion } from "../../lib/internal/reload/loaded.ts";
import {
	SANDBOX_NAMES,
	SANDBOX_VARIABLE,
} from "../../lib/internal/sandbox/sandbox.ts";
import type { FleetAssignment } from "./run.ts";

/** One job as the model asked for it, as far as this reads it. */
interface AskedJob {
	readonly id: string;
	readonly extraExtensions?: readonly string[];
	readonly verify?: {
		readonly extensionPath: string;
		readonly skillPath?: string;
	};
}

/** The jobs, each named extension followed to where it lies, or why not. */
export type Kept<T> =
	| { readonly ok: true; readonly jobs: T[] }
	| { readonly ok: false; readonly refusal: string };

/** The sandbox this session's own commands run in, by name, or nothing. */
export function sessionSandbox(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return askedSandbox(env, SANDBOX_NAMES).name;
}

/**
 * The sandbox this session's subagents run in, by name, or nothing when
 * they run unfenced: this session's own, or, once subagents join the
 * first stage, the fence, as each child would work it out for itself.
 */
export function childSandbox(
	env: NodeJS.ProcessEnv = process.env,
	joined: () => boolean = spawnsJoin,
): string | undefined {
	return sessionSandbox(env) ?? (joined() ? SANDBOX_NAMES.fence : undefined);
}

/**
 * The extensions that fence a pi: its bash, which runs each command in
 * the sandbox, its file tools' guard and the scrub of what they answer.
 */
const FENCE_PACKS = [
	"extensions/shell-workflow/index.ts",
	"extensions/sandbox-file-interceptor/index.ts",
	"extensions/secret-scrub-interceptor/index.ts",
] as const;

/**
 * Where to take the fence's extensions from: the current version of the
 * install this package was loaded from, which a session that started on
 * an older one still finds after the install moves. A session running
 * a tree, which only an unfenced one may start children from, takes them
 * from the install its settings name; failing both, this package's own
 * folder, which `follow` then refuses unless it is installed.
 */
export function packsHome(
	own: string = packageRoot(),
	harness: () => string | undefined = settingsHarness,
): string {
	let real: string;
	try {
		real = realpathSync(own);
	} catch {
		return own;
	}
	const install = installOfVersion(real) ?? installOfVersion(harness() ?? real);
	return install === undefined ? real : join(install, "current");
}

/** What runs when the model wants to try code it wrote, said in each refusal. */
const TRY_IT =
	"To try one you wrote, run pi on it as a command (pi -p --extension <path>), which the fence holds";

/**
 * Why `real`, inside the install, lies in a version its install's
 * `current` link has left, or nothing when it doesn't. The install is
 * the shallowest folder holding a `current` link beside a version
 * folder, so a folder named versions inside a package is never taken
 * for one.
 */
function olderVersion(real: string, root: string): string | undefined {
	const steps = relative(root, real).split(sep);
	for (let depth = 1; depth < steps.length; depth += 1) {
		const folder = join(root, ...steps.slice(0, depth));
		const install = installOfVersion(folder);
		// The link itself, followed or not: one left dangling still marks
		// an install, whose versions then all count as left behind.
		if (install === undefined || !lstatExists(join(install, "current"))) {
			continue;
		}
		let current: string | undefined;
		try {
			current = realpathSync(join(install, "current"));
		} catch {
			current = undefined;
		}
		return current === folder
			? undefined
			: `lies in a version of ${relative(root, install)} its install has moved on from, which may lack a fix the current one has; name the one under ${join(install, "current")}`;
	}
	return undefined;
}

/** Whether anything, a dangling link included, is at `path`. */
function lstatExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Where `path` really lies inside `root`, which `where` names, or why
 * it can't be loaded.
 */
function follow(
	path: string,
	root: string | null,
	where = "pi's installed packages",
): { real: string } | { why: string } {
	if (!isAbsolute(path)) {
		return { why: `${path} isn't an absolute path` };
	}
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return { why: `${path} can't be found` };
	}
	if (root === null) {
		return {
			why: `${path} can't be loaded, since pi's installed packages can't be found`,
		};
	}
	if (!inside(real, root)) {
		return {
			why: `${path} lies outside ${where}, and a subagent's pi runs outside the fence, so it can load an extension only from there. ${TRY_IT}`,
		};
	}
	const older = olderVersion(real, root);
	return older === undefined ? { real } : { why: `${path} ${older}` };
}

/**
 * Each job with every extension it names followed to where it lies, or
 * why none may start: one names an extension outside the current
 * versions of pi's installed packages, or one that isn't there. Jobs of
 * a session whose children run unfenced (`sandbox` undefined) are left
 * as they are.
 */
export function keepFence<T extends AskedJob>(
	jobs: readonly T[],
	sandbox: string | undefined,
	root: string | null = installedPackages(),
): Kept<T> {
	if (sandbox === undefined) return { ok: true, jobs: [...jobs] };
	const reasons: string[] = [];
	const kept = jobs.map((job) => {
		const real = (path: string): string => {
			const followed = follow(path, root);
			if ("why" in followed) {
				reasons.push(`${job.id}: ${followed.why}.`);
				return path;
			}
			return followed.real;
		};
		const extraExtensions = job.extraExtensions?.map(real);
		const verify = job.verify && {
			...job.verify,
			extensionPath: real(job.verify.extensionPath),
		};
		return {
			...job,
			...(extraExtensions ? { extraExtensions } : {}),
			...(verify ? { verify } : {}),
		};
	});
	return reasons.length === 0
		? { ok: true, jobs: kept }
		: { ok: false, refusal: `No subagent started:\n${reasons.join("\n")}` };
}

/**
 * The fence's extensions, each followed to where it lies in the install
 * as a named one is, or why an isolated child can't be fenced. When the
 * harness itself lies in the Nix store, they must lie in that same copy
 * of it, never elsewhere in the store.
 */
export function fencePacks(
	home: string = packsHome(),
	root: string | null = installedPackages(),
	store: string = NIX_STORE,
	own: string = packageRoot(),
	changeable: (path: string) => boolean = canChange,
): { readonly packs: string[] } | { readonly why: string } {
	const stored = inside(home, store);
	const copy = stored ? heldStoreCopy(own, store, changeable) : undefined;
	if (stored && copy === undefined) {
		return {
			why: `No subagent started: an isolated subagent of a fenced session needs the fence's own extensions, and ${home} lies in the Nix store but not in a copy of this session's own harness this account can't change. Unisolated subagents need the install too, so start them from a session whose harness loads from pi's installed packages.`,
		};
	}
	const within = copy ?? root;
	const where =
		copy === undefined
			? "pi's installed packages"
			: `this harness's copy in the Nix store, ${copy}`;
	const packs: string[] = [];
	for (const pack of FENCE_PACKS) {
		const followed = follow(join(home, ...pack.split("/")), within, where);
		const why =
			"why" in followed
				? followed.why
				: copy !== undefined && !unchangeable(followed.real, changeable)
					? `${followed.real} is one this account could change`
					: undefined;
		if (why !== undefined) {
			return {
				why: `No subagent started: an isolated subagent of a fenced session needs the fence's own extensions from ${where}, and ${why}. ${copy === undefined ? "Reload onto the install, or start the subagents unisolated" : "This copy of the harness can't give them; start the subagents from a session whose harness loads from pi's installed packages"}.`,
			};
		}
		if ("real" in followed) packs.push(followed.real);
	}
	return { packs };
}

/**
 * Each assignment fenced as `sandbox` says: told the sandbox by name,
 * ignoring project-local files, and, when isolated, loading the fence's
 * own extensions first. Left as it is when the children run unfenced;
 * refused when an isolated child needs the fence's extensions and they
 * aren't in the install.
 */
export function fenceChildren(
	assignments: readonly FleetAssignment[],
	sandbox: string | undefined,
	packsOf: () => ReturnType<typeof fencePacks> = fencePacks,
): Kept<FleetAssignment> {
	if (sandbox === undefined) return { ok: true, jobs: [...assignments] };
	let packs: string[] | undefined;
	if (assignments.some(({ job }) => job.isolated)) {
		const found = packsOf();
		if ("why" in found) return { ok: false, refusal: found.why };
		packs = found.packs;
	}
	const jobs = assignments.map(({ spec, job }) => {
		const named = job.extraExtensions ?? [];
		const extraExtensions =
			job.isolated && packs
				? [...packs.filter((pack) => !named.includes(pack)), ...named]
				: job.extraExtensions;
		return {
			spec,
			job: {
				...job,
				// A folder's `.pi` is code a fenced command may have written,
				// and this child's pi runs outside the fence.
				ignoreProject: true,
				env: { ...job.env, [SANDBOX_VARIABLE]: sandbox },
				...(extraExtensions ? { extraExtensions } : {}),
			},
		};
	});
	return { ok: true, jobs };
}
