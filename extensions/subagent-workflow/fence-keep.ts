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
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	askedSandbox,
	spawnsJoin,
} from "../../lib/internal/fence/fence-stage.ts";
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

/**
 * The sandbox this session's subagents run in, by name, or nothing when
 * they run unfenced: this session's own, or, once subagents join the
 * first stage, the fence, as each child would work it out for itself.
 */
export function childSandbox(
	env: NodeJS.ProcessEnv = process.env,
	joined: () => boolean = spawnsJoin,
): string | undefined {
	return (
		askedSandbox(env, SANDBOX_NAMES).name ??
		(joined() ? SANDBOX_NAMES.fence : undefined)
	);
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

/** This package's own folder, as loaded. */
const OWN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where to take the fence's extensions from: the current version of the
 * install this package was loaded from, which a session that started on
 * an older one still finds after the install moves, or this package's
 * own folder, which `follow` then refuses unless it is installed.
 */
function packsHome(own: string = OWN_ROOT): string {
	let real: string;
	try {
		real = realpathSync(own);
	} catch {
		return own;
	}
	const install = installOfVersion(real);
	return install === undefined ? real : join(install, "current");
}

/** Where pi's packages are installed, which the fence holds read-only. */
function installRoot(): string | null {
	try {
		return realpathSync(join(homedir(), ".local", "share", "pi-packages"));
	} catch {
		return null;
	}
}

/** What runs when the model wants to try code it wrote, said in each refusal. */
const TRY_IT =
	"To try one you wrote, run pi on it as a command (pi -p --extension <path>), which the fence holds";

/**
 * Why `real`, inside the install, lies in a version its install's
 * `current` link has left, or nothing when it doesn't.
 */
function olderVersion(real: string, root: string): string | undefined {
	for (
		let folder = dirname(real);
		folder !== root && folder.startsWith(root + sep);
		folder = dirname(folder)
	) {
		const install = installOfVersion(folder);
		if (install === undefined) continue;
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

/** Where `path` really lies inside `root`, or why it can't be loaded. */
function follow(
	path: string,
	root: string | null,
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
	if (real !== root && !real.startsWith(root + sep)) {
		return {
			why: `${path} lies outside pi's installed packages, and a subagent's pi runs outside the fence, so it can load an extension only from there. ${TRY_IT}`,
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
	root: string | null = installRoot(),
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
 * as a named one is, or why an isolated child can't be fenced.
 */
export function fencePacks(
	home: string = packsHome(),
	root: string | null = installRoot(),
): { readonly packs: string[] } | { readonly why: string } {
	const packs: string[] = [];
	for (const pack of FENCE_PACKS) {
		const followed = follow(join(home, ...pack.split("/")), root);
		if ("why" in followed) {
			return {
				why: `No subagent started: an isolated subagent of a fenced session needs the fence's own extensions from pi's installed packages, and ${followed.why}. Reload onto the install, or start the subagents unisolated.`,
			};
		}
		packs.push(followed.real);
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
