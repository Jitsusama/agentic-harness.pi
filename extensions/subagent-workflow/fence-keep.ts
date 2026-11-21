/**
 * What keeps a subagent from carrying code past the fence.
 *
 * A subagent's pi runs outside the fence its parent's commands run in,
 * and an extension it loads runs there too, as the person. So the model
 * may not name an extension a fenced command could have written: only
 * one inside pi's installed packages, which the fence holds read-only
 * (`fence-home.ts`). Not this package's own folder, since a session
 * reloaded onto a worktree runs from a tree its commands may write.
 *
 * Each named path is followed to where it really lies, and the child is
 * handed that, so a link swapped between this check and the start can't
 * point it somewhere else. A folder's own `.pi` is kept out another way:
 * the tool starts every subagent ignoring project-local files.
 *
 * And a fenced session's subagents are fenced too. The fence holds a
 * pi's commands through this package's own bash, which an isolated
 * child, started without extensions, would never load: its bash would
 * be pi's plain one, run as the person. So in a fenced or strict
 * session each child is told its sandbox by name, since a session the
 * fence's first stage lists has none in its environment to pass on, and
 * an isolated one loads the fence's bash and file guards by path.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { askedSandbox } from "../../lib/internal/fence/fence-stage.ts";
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
 * The extensions that fence a pi: its bash, which runs each command in
 * the sandbox, its file tools' guard and the scrub of what they answer.
 */
const FENCE_PACKS = [
	"extensions/shell-workflow/index.ts",
	"extensions/sandbox-file-interceptor/index.ts",
	"extensions/secret-scrub-interceptor/index.ts",
] as const;

/** The fence's extensions, where this package has them. */
function fencePacks(): string[] {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	return FENCE_PACKS.map((path) => join(root, ...path.split("/")));
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
	return { real };
}

/**
 * Each job with every extension it names followed to where it lies, or
 * why none may start: one names an extension outside pi's installed
 * packages, or one that isn't there.
 */
export function keepFence<T extends AskedJob>(
	jobs: readonly T[],
	root: string | null = installRoot(),
): Kept<T> {
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
 * Each assignment fenced as this session is: told the sandbox `sandbox`
 * names, and, when isolated, loading the fence's own extensions first.
 * Left as it is when this session runs unfenced.
 */
export function fenceChildren(
	assignments: readonly FleetAssignment[],
	sandbox: string | undefined = askedSandbox(process.env, SANDBOX_NAMES).name,
	packs: readonly string[] = fencePacks(),
): FleetAssignment[] {
	if (sandbox === undefined) return [...assignments];
	return assignments.map(({ spec, job }) => {
		const named = job.extraExtensions ?? [];
		const extraExtensions = job.isolated
			? [...packs.filter((pack) => !named.includes(pack)), ...named]
			: job.extraExtensions;
		return {
			spec,
			job: {
				...job,
				env: { ...job.env, [SANDBOX_VARIABLE]: sandbox },
				...(extraExtensions ? { extraExtensions } : {}),
			},
		};
	});
}
