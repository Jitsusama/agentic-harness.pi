/**
 * The answer a commit gets when it asks whether anything is failing.
 *
 * Nothing here is taken on trust from an earlier pass. The files that
 * last had errors are checked again, and only those in the repository
 * the commit lands in. A failed check run counts only while its tree
 * is the one it judged. Whatever cannot be confirmed now is not held
 * against the commit: refusing on a guess is what this replaced. Nor
 * is it forgotten on a guess: a run git couldn't answer for stays
 * recorded for the next ask.
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
import { gitRoot, present, treeFingerprint, within } from "./tree.ts";

/**
 * How many times a check asks after a run recorded while git answered
 * for the one before, before it leaves the newest for the next ask.
 */
const JUDGED_AT_MOST = 3;

/** Where a failed run's tree stands: as it judged, moved on, or unsaid. */
export type Standing = "same" | "moved" | "unknown";

/** A failed run and where its tree stood when git was last asked. */
export interface Judged {
	readonly run: FailedRun;
	readonly standing: Standing;
}

/** What a commit's check found, and the run it asked git about. */
export interface FailureNow {
	readonly failure: VerificationFailure | undefined;
	readonly judged: Judged | undefined;
}

/**
 * What is failing in the scope's repository, confirmed now, with the
 * run it asked git about, so the caller needn't ask again for it.
 * Updates what the state knows along the way, so a fixed file stops
 * counting.
 */
export async function failureNow(
	state: VerificationState,
	scope: VerificationScope,
	backend: DiagnosticsBackend | undefined,
): Promise<FailureNow> {
	const root = scope.dir
		? ((await gitRoot(scope.dir, scope.signal)) ?? scope.dir)
		: undefined;
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

	let judged: Judged | undefined;
	for (let tries = 0; tries < JUDGED_AT_MOST; tries++) {
		const run = state.failedRun;
		if (!run || !inScope(run.root)) break;
		judged = { run, standing: await standingOf(run, scope.signal) };
		// Only the run still recorded once git answers counts: one an edit
		// or a clean verify cleared meanwhile is gone, and one recorded
		// meanwhile is asked about in turn.
		if (state.failedRun !== run) continue;
		if (judged.standing === "same") {
			problems.push(
				`${run.command} failed in ${run.root}, and nothing there has ` +
					"changed since. Run verify again once it is fixed.",
			);
		} else if (judged.standing === "moved") {
			state.failedRun = undefined;
		}
		break;
	}
	const failure = problems.length > 0 ? { problems } : undefined;
	return { failure, judged };
}

/**
 * What a commit is told, confirmed now, settling the state's outcome
 * from the same answer when it was failing or now fails. A check whose
 * run was overtaken past its bound asks git nothing more: the newest
 * run is the next ask's.
 */
export async function commitCheck(
	state: VerificationState,
	scope: VerificationScope,
	backend: DiagnosticsBackend | undefined,
): Promise<VerificationFailure | undefined> {
	const { failure, judged } = await failureNow(state, scope, backend);
	if (state.outcome === "failing" || failure) {
		const overtaken = judged !== undefined && judged.run !== state.failedRun;
		state.outcome = overtaken
			? outcomeOf(state)
			: await settle(state, judged, scope.signal);
	}
	return failure;
}

/**
 * Where a failed run's tree stands. Outside git there is no fingerprint
 * to compare, and an edit under its root is what retires it instead;
 * one git said nothing of when it ran can't be compared either. A root
 * no longer on disk holds nothing it judged, however it was recorded.
 */
export async function standingOf(
	run: FailedRun,
	signal?: AbortSignal,
): Promise<Standing> {
	const kept = run.fingerprint === undefined ? "same" : "unknown";
	if (typeof run.fingerprint === "string") {
		const now = await treeFingerprint(run.root, signal);
		if (now !== undefined) return now === run.fingerprint ? "same" : "moved";
	}
	if (signal?.aborted) return kept;
	return (await present(run.root)) ? kept : "moved";
}

/**
 * The outcome for what the state knows now, retiring a failed run
 * whose tree has moved on, so the status line is no staler than the
 * answer a commit would get. A run `judged` already answers for is not
 * asked about again, and git stops being asked once `signal` fires.
 */
export async function settle(
	state: VerificationState,
	judged?: Judged,
	signal?: AbortSignal,
): Promise<"clean" | "failing"> {
	const run = state.failedRun;
	const standing = !run
		? undefined
		: judged?.run === run
			? judged.standing
			: await standingOf(run, signal);
	// Retired only if it is still the one asked about once git answers.
	if (run && standing === "moved" && state.failedRun === run) {
		state.failedRun = undefined;
	}
	return outcomeOf(state);
}

/** The outcome for what the state knows, asking nobody. */
function outcomeOf(state: VerificationState): "clean" | "failing" {
	return state.known.size > 0 || state.failedRun ? "failing" : "clean";
}
