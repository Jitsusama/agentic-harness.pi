/**
 * The answer a commit gets when it asks whether anything is failing.
 *
 * Nothing here is taken on trust from an earlier pass. The files that
 * last had errors are checked again, and only those in the repository
 * the commit lands in. A failed check run counts only while its tree
 * is the one it judged. Whatever cannot be confirmed now is not held
 * against the commit: refusing on a guess is what this replaced.
 */

import type {
	VerificationFailure,
	VerificationScope,
} from "../../lib/internal/verification/signal.ts";
import {
	collectErrors,
	type DiagnosticsBackend,
	describeError,
	rememberChecked,
} from "./diagnostics.ts";
import {
	COMMIT_CHECK_WALL_MS,
	type FailedRun,
	type VerificationState,
} from "./state.ts";
import { gitRoot, treeFingerprint, within } from "./tree.ts";

/**
 * What is failing in the scope's repository, confirmed now. Updates
 * what the state knows along the way, so a fixed file stops counting.
 */
export async function currentFailure(
	state: VerificationState,
	scope: VerificationScope,
	backend: DiagnosticsBackend | undefined,
): Promise<VerificationFailure | undefined> {
	const root = scope.dir ? (gitRoot(scope.dir) ?? scope.dir) : undefined;
	const inScope = (path: string): boolean =>
		root === undefined || within(root, path);
	const problems: string[] = [];

	const files = [...state.known.keys()].filter(inScope);
	if (backend && files.length > 0) {
		const result = await collectErrors(
			backend,
			files,
			scope.signal,
			COMMIT_CHECK_WALL_MS,
		);
		rememberChecked(state, result);
		problems.push(...result.errors.map(describeError));
	}
	// The fix loop has no business with a file that came back clean.
	state.pending = state.pending.filter((e) => state.known.has(e.path));

	const run = state.failedRun;
	if (run && inScope(run.root)) {
		if (stillDescribes(run)) {
			problems.push(
				`${run.command} failed in ${run.root}, and nothing there has ` +
					"changed since. Run verify again once it is fixed.",
			);
		} else {
			state.failedRun = undefined;
		}
	}
	return problems.length > 0 ? { problems } : undefined;
}

/**
 * Whether a failed run still describes its tree. Outside git there is
 * no fingerprint to compare, and an edit under its root is what
 * retires it instead.
 */
export function stillDescribes(run: FailedRun): boolean {
	if (run.fingerprint === undefined) return true;
	return treeFingerprint(run.root) === run.fingerprint;
}

/**
 * The outcome for what the state knows now, retiring a failed run
 * whose tree has moved on, so the status line is no staler than the
 * answer a commit would get.
 */
export function settle(state: VerificationState): "clean" | "failing" {
	if (state.failedRun && !stillDescribes(state.failedRun)) {
		state.failedRun = undefined;
	}
	return state.known.size > 0 || state.failedRun ? "failing" : "clean";
}
