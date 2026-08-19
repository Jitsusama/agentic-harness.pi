/**
 * Pi's prepare-commit-msg hook wiring over agentic-harness.core's
 * host-agnostic commit-hook mechanism. Pi's own contribution is
 * just the options: an env var pi sets right before its own bash
 * tool call is the gate, since pi's extension runs in the same
 * process as the tool call it precedes. A Claude Code adapter
 * can't do that (its hook is a separate process that can't inject
 * env vars forward into the tool call that follows), so it gates
 * on something else entirely: see agentic-harness.claude.
 */

import {
	buildPrepareCommitMsgHook,
	type CommitHookOptions,
	ensureCommitHook as ensureCommitHookWith,
	type HookInstall,
	installCommitHook as installCommitHookWith,
} from "@jitsusama/agentic-harness.core/attribution";

export type { HookInstall } from "@jitsusama/agentic-harness.core/attribution";
export { repoRootOf } from "@jitsusama/agentic-harness.core/attribution";

/** Pi's own commit-hook options: gated on the PI_CO_AUTHOR env var. */
const PI_OPTIONS: CommitHookOptions = {
	marker: "pi-commit-attribution-hook",
	chainedSuffix: "pi-chained",
	gateTest: '[ -n "$PI_CO_AUTHOR" ]',
	trailerExpr: '"$PI_CO_AUTHOR"',
};

/** The prepare-commit-msg script pi installs. */
export const PREPARE_COMMIT_MSG_HOOK = buildPrepareCommitMsgHook(PI_OPTIONS);

/**
 * Install the prepare-commit-msg hook into a repo's hooks
 * directory, honouring core.hooksPath and chaining any existing
 * hook. A no-op when pi's hook is already installed.
 */
export function installCommitHook(repoRoot: string): HookInstall {
	return installCommitHookWith(repoRoot, PI_OPTIONS);
}

/**
 * Ensure the hook is installed in the repo containing dir, at most
 * once per repo root. This is how hook coverage follows the
 * session into repos it later cds into, rather than only the repo
 * pi started in.
 */
export function ensureCommitHook(dir: string, installed: Set<string>): void {
	ensureCommitHookWith(dir, installed, PI_OPTIONS);
}
