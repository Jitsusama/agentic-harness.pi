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
 * assuming. Everything else — idempotent install, chaining any
 * hook the repo already had, never adding a second AI co-author —
 * is host-agnostic and shared.
 */

import { execFileSync } from "node:child_process";
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

/** Build the prepare-commit-msg script for the given adapter options. */
export function buildPrepareCommitMsgHook(options: CommitHookOptions): string {
	return `#!/bin/sh
# ${options.marker}
# Appends the AI co-author trailer to commits made under this adapter.
# Idempotent and chains to any displaced hook.

msg_file="$1"

chained="$(CDPATH= cd "$(dirname "$0")" && pwd)/prepare-commit-msg.${options.chainedSuffix}"
if [ -x "$chained" ]; then
	"$chained" "$@" || exit $?
fi

${options.gateTest} || exit 0
[ -f "$msg_file" ] || exit 0

if grep -qi 'co-authored-by[: ]*ai' "$msg_file"; then
	exit 0
fi

git interpret-trailers --in-place --trailer ${options.trailerExpr} "$msg_file"
`;
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
 * Ensure the hook is installed in the repo containing dir, at most
 * once per repo. Records both dir and its repo root in `installed`,
 * so a later command from either asks git nothing, and installs
 * best-effort. A directory outside any git repo is a no-op and is
 * not remembered, so a repo initialised there later is still
 * covered. This is how hook coverage follows the session into repos
 * it later cds into, rather than only the repo the session started
 * in. Each git call is a synchronous spawn on the command path, so
 * a first visit costs one and a repeat costs none.
 */
/**
 * How long one git probe on the command path may take.
 *
 * The probe is synchronous, because it has to land before the command
 * runs, so while it waits nothing in pi renders or reads a key. A
 * rev-parse answers in milliseconds; one still silent at two seconds is
 * stuck on a hung mount or a filesystem that stopped responding.
 */
export const GIT_PROBE_TIMEOUT_MS = 2000;

export function ensureCommitHook(
	dir: string,
	installed: Set<string>,
	options: CommitHookOptions,
): void {
	if (installed.has(dir)) return;
	const layout = locateHooks(dir);
	// A git that never answered is not asked about this directory again
	// this session: its commits go unhooked, which costs a trailer,
	// where asking again would freeze pi for the clock on every command.
	if (layout === UNANSWERED) {
		installed.add(dir);
		return;
	}
	if (!layout) return;
	installed.add(dir);
	if (installed.has(layout.root)) return;
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
		answer = execFileSync(
			"git",
			[
				"-C",
				dir,
				"rev-parse",
				"--show-toplevel",
				"--git-common-dir",
				"--git-path",
				"hooks",
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_PROBE_TIMEOUT_MS,
			},
		);
	} catch (error) {
		if (ranOutClock(error)) return UNANSWERED;
		// Not in a working tree (or git unavailable): nothing to hook.
		return null;
	}
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
