/**
 * The prepare-commit-msg hook that attributes every commit made
 * under an adapter, not just a typed `git commit`. Command-level
 * injection only sees a literal git commit; cherry-pick, revert,
 * rebase, merge and editor commits reach attribution only through
 * this hook.
 *
 * The trigger condition (an env var pi can set before its own tool
 * call, a marker file a Claude Code hook can only write to disk,
 * ...) is the one thing that genuinely differs per adapter, so it's
 * the one thing this module takes as a parameter rather than
 * assuming. Everything else (idempotent install, chaining any
 * hook the repo already had, never adding a second AI co-author)
 * is host-agnostic and shared.
 */

import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * How an adapter's hook decides whether to attribute a commit, and
 * how it identifies its own installed hook.
 */
export interface CommitHookOptions {
	/** Comment marker identifying this as this adapter's hook, for idempotent (re)installs. */
	readonly marker: string;
	/** Filename suffix for a pre-existing hook this displaces (e.g. "pi-chained"). */
	readonly chainedSuffix: string;
	/** Shell test that must succeed for this commit to be attributed, e.g. `[ -n "$PI_CO_AUTHOR" ]`. */
	readonly gateTest: string;
	/** Shell expression yielding the trailer line text, e.g. `"$PI_CO_AUTHOR"`. */
	readonly trailerExpr: string;
}

/** The hook's script, with an `@name@` left for each of an adapter's options. */
const HOOK_SCRIPT = new URL("./prepare-commit-msg.sh", import.meta.url);

/** An `@name@` the hook's script leaves for an option. */
const BLANK = /@(\w+)@/g;

/**
 * Build the prepare-commit-msg script for the given adapter options. Each
 * option is written in as it is, since two of them are shell the hook
 * runs. A blank no option fills is refused rather than left in a hook
 * that would fail on every commit.
 */
export function buildPrepareCommitMsgHook(options: CommitHookOptions): string {
	const filled = new Map<string, string>([
		["marker", options.marker],
		["chainedSuffix", options.chainedSuffix],
		["gateTest", options.gateTest],
		["trailerExpr", options.trailerExpr],
	]);
	return readFileSync(HOOK_SCRIPT, "utf8").replaceAll(
		BLANK,
		(_blank, name: string) => {
			const value = filled.get(name);
			if (value === undefined) {
				throw new Error(
					`prepare-commit-msg.sh leaves @${name}@, and no option fills it`,
				);
			}
			return value;
		},
	);
}

/** The outcome of trying to install the hook. */
export interface HookInstall {
	readonly installed: boolean;
	readonly reason?: string;
}

/**
 * Install the prepare-commit-msg hook into a repo's hooks
 * directory, honouring core.hooksPath and chaining any existing
 * hook. A no-op when this adapter's hook is already installed.
 */
export function installCommitHook(
	repoRoot: string,
	options: CommitHookOptions,
): HookInstall {
	const layout = locateHooks(repoRoot);
	if (layout === UNANSWERED) {
		return { installed: false, reason: "git did not answer" };
	}
	if (!layout) return { installed: false, reason: "not a git repo" };
	return installInto(layout, options);
}

/** Install the hook into a repo whose hooks have been located. */
function installInto(
	{ hooksDir, customHooksPath }: HooksLayout,
	options: CommitHookOptions,
): HookInstall {
	// A custom core.hooksPath means a hook manager (husky and the
	// like) or a shared, possibly version-controlled hooks directory
	// owns the hooks. Leave it alone rather than write this adapter's
	// hook into a directory it does not own.
	if (customHooksPath) {
		return { installed: false, reason: "custom core.hooksPath configured" };
	}

	const target = join(hooksDir, "prepare-commit-msg");
	if (
		existsSync(target) &&
		readFileSync(target, "utf8").includes(options.marker)
	) {
		return { installed: false, reason: "already installed" };
	}

	if (existsSync(target)) {
		const chained = join(
			hooksDir,
			`prepare-commit-msg.${options.chainedSuffix}`,
		);
		// A backup already here means a non-adapter hook was chained
		// before; renaming over it would lose the original, so refuse
		// instead.
		if (existsSync(chained)) {
			return {
				installed: false,
				reason: `a prepare-commit-msg.${options.chainedSuffix} backup already exists`,
			};
		}
		renameSync(target, chained);
	}

	writeFileSync(target, buildPrepareCommitMsgHook(options), { mode: 0o755 });
	chmodSync(target, 0o755);
	return { installed: true };
}

/**
 * How long one git probe on the command path may take.
 *
 * The probe has to land before the command runs, so the command waits
 * on it. A rev-parse answers in milliseconds; one still silent at two
 * seconds is stuck on a hung mount or a filesystem that stopped
 * responding.
 */
export const GIT_PROBE_TIMEOUT_MS = 2000;

/**
 * Ensure the hook is installed in the repo containing dir, at most
 * once per repo. Records both dir and its repo root in `installed`,
 * so a later command from either asks git nothing, and installs
 * best-effort. A directory outside any git repo is a no-op and is
 * not remembered, so a repo initialised there later is still
 * covered. This is how hook coverage follows the session into repos
 * it later cds into, rather than only the repo the session started
 * in. A first visit costs one git call and a repeat costs none.
 *
 * The call is asynchronous, so pi's loop stays free while git answers:
 * a host runs every conversation on one loop, and a soak of twelve
 * spent 4.9 s of it in this probe's synchronous spawn (13 November).
 * The install itself follows the answer synchronously, so two calls
 * awaiting the same repo cannot both install into it.
 */
export async function ensureCommitHook(
	dir: string,
	installed: Set<string>,
	options: CommitHookOptions,
): Promise<void> {
	if (installed.has(dir)) return;
	const layout = await askHooks(dir);
	// A git that never answered is not asked about this directory again
	// this session: its commits go unhooked, which costs a trailer,
	// where asking again would freeze pi for the clock on every command.
	if (layout === UNANSWERED) {
		installed.add(dir);
		return;
	}
	if (!layout) return;
	// The root is asked after before the folder is noted: noted first, a
	// command run at the repo's own root, as git spells it, found its root
	// already there and never installed. Only a folder named some other
	// way, such as through a symlinked /tmp, ever got the hook, which is
	// why it passed on one machine and failed on penelope (8 November).
	const rootSeen = installed.has(layout.root);
	installed.add(dir);
	if (rootSeen) return;
	installed.add(layout.root);
	try {
		installInto(layout, options);
	} catch {
		// Best-effort: never let hook installation break a command.
	}
}

/** The probe's answer when git ran out the clock. */
const UNANSWERED = Symbol("unanswered");

/** True when a synchronous spawn was killed for running out its clock. */
function ranOutClock(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "ETIMEDOUT"
	);
}

/** Where a repo keeps its hooks. */
interface HooksLayout {
	/** The working tree's root. */
	readonly root: string;
	/** The active hooks directory, honouring core.hooksPath. */
	readonly hooksDir: string;
	/** Whether core.hooksPath moves the hooks away from the default. */
	readonly customHooksPath: boolean;
}

/**
 * Locate the hooks of the repo containing dir with one git call, or
 * null when dir is in no working tree. Git prints the default hooks
 * path as the common dir plus `/hooks`, in the same form, so any
 * other answer means core.hooksPath points somewhere else.
 */
function locateHooks(dir: string): HooksLayout | null | typeof UNANSWERED {
	let answer: string;
	try {
		answer = execFileSync("git", hooksQuestion(dir), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_PROBE_TIMEOUT_MS,
		});
	} catch (error) {
		if (ranOutClock(error)) return UNANSWERED;
		// Not in a working tree (or git unavailable): nothing to hook.
		return null;
	}
	return layoutFrom(dir, answer);
}

/** {@link locateHooks}, asked without holding pi's loop. */
function askHooks(
	dir: string,
): Promise<HooksLayout | null | typeof UNANSWERED> {
	return new Promise((resolve) => {
		execFile(
			"git",
			hooksQuestion(dir),
			{ encoding: "utf8", timeout: GIT_PROBE_TIMEOUT_MS },
			(error, stdout) => {
				if (!error) resolve(layoutFrom(dir, stdout));
				// Killed by the clock reads as unanswered; any other failure
				// is no working tree (or no git): nothing to hook.
				else resolve(error.killed ? UNANSWERED : null);
			},
		);
	});
}

/** The one git call that locates a folder's repo and its hooks. */
function hooksQuestion(dir: string): string[] {
	return [
		"-C",
		dir,
		"rev-parse",
		"--show-toplevel",
		"--git-common-dir",
		"--git-path",
		"hooks",
	];
}

/** The hooks layout git's answer to {@link hooksQuestion} gives. */
function layoutFrom(dir: string, answer: string): HooksLayout | null {
	const [root, commonDir, hooks] = answer.trimEnd().split("\n");
	if (!root || !commonDir || !hooks) return null;
	return {
		root,
		// Relative paths are relative to the directory git ran in.
		hooksDir: isAbsolute(hooks) ? hooks : join(dir, hooks),
		customHooksPath: hooks !== `${commonDir}/hooks`,
	};
}

/** The git repository root containing dir, or null when there is none. */
export function repoRootOf(dir: string): string | null {
	try {
		const root = execFileSync(
			"git",
			["-C", dir, "rev-parse", "--show-toplevel"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_PROBE_TIMEOUT_MS,
			},
		).trim();
		return root.length > 0 ? root : null;
	} catch {
		// Not a git repository (or git unavailable): no hook to install.
		return null;
	}
}
