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
	type CommitHookOptions,
	ensureCommitHook as ensureCommitHookWith,
	type HookInstall,
	installCommitHook as installCommitHookWith,
} from "../../core/attribution/index.ts";
import { STRICT, sandboxName } from "../sandbox/sandbox.ts";

export type { HookInstall } from "../../core/attribution/index.ts";

/** Pi's own commit-hook options: gated on the PI_CO_AUTHOR env var. */
const PI_OPTIONS: CommitHookOptions = {
	marker: "pi-commit-attribution-hook",
	chainedSuffix: "pi-chained",
	gateTest: '[ -n "$PI_CO_AUTHOR" ]',
	trailerExpr: '"$PI_CO_AUTHOR"',
};

/**
 * Install the prepare-commit-msg hook into a repo's hooks
 * directory, honouring core.hooksPath and chaining any existing
 * hook. A no-op when pi's hook is already installed.
 */
export function installCommitHook(repoRoot: string): HookInstall {
	return installCommitHookWith(repoRoot, PI_OPTIONS);
}

/**
 * Whether this pi's commands carry `PI_CO_AUTHOR` to git. A strict
 * sandbox hands its commands only the variables it knows are harmless,
 * and this is not one of them, so there the hook could attribute
 * nothing: it would only be one more thing a commit can fail on, as a
 * room's strict session found it could not run (S99IA2 [acf576c3]).
 */
function hookCanAttribute(env: NodeJS.ProcessEnv = process.env): boolean {
	return sandboxName(env) !== STRICT;
}

/**
 * Ensure the hook is installed in the repo containing dir, at most
 * once per repo root. This is how hook coverage follows the
 * session into repos it later cds into, rather than only the repo
 * pi started in. A pi whose commands can't carry the trailer writes
 * none.
 */
export async function ensureCommitHook(
	dir: string,
	installed: Set<string>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!hookCanAttribute(env)) return;
	await ensureCommitHookWith(dir, installed, PI_OPTIONS);
}
