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
 * How many times a check asks after a project's run recorded while git
 * answered for the one before, before it holds the commit on the newest
 * as it was recorded, asking git no more.
 */
const JUDGED_AT_MOST = 3;

/** Where a failed run's tree stands: as it judged, moved on, or unsaid. */
export type Standing = "same" | "moved" | "unknown";

/** A failed run and where its tree stood when git was last asked. */
export interface Judged {
	readonly run: FailedRun;
	readonly standing: Standing;
}

/**
 * What a commit's check found, the runs git was asked about, with
 * where each stood (unknown where git gave no answer), and the
 * projects git is to be asked about no more on this check: those
 * whose runs verifies kept overtaking, and those outside the commit's
 * repository, which its check has no business asking git about.
 */
export interface FailureNow {
	readonly failure: VerificationFailure | undefined;
	readonly judged: readonly Judged[];
	readonly leave: ReadonlySet<string>;
}

/** What asking after one project's failed run found. */
type Asked =
	| { readonly judged: Judged; readonly problem?: string }
	| { readonly overtaken: string; readonly problem: string }
	| undefined;

/**
 * What is failing in the scope's repository, confirmed now, with the
 * runs it asked git about, so the caller needn't ask again for them.
 * Updates what the state knows along the way, so a fixed file stops
 * counting.
 */
export async function failureNow(
	state: VerificationState,
	scope: VerificationScope,
	backend: DiagnosticsBackend | undefined,
): Promise<FailureNow> {
	// A commit always sits in a repository, so a folder git names none for
	// is one git was silent on, and only runs at or below it count: one
	// above may be another repository's, so it isn't held on a guess.
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

	const judged: Judged[] = [];
	const leave = new Set<string>();
	// One project at a time, so a commit's check never sets several git
	// statuses on the disk it waits on at once; a project whose run is
	// recorded while others are asked about is asked about in its turn.
	const asked = new Set<string>();
	for (;;) {
		const at = [...state.failedRuns.keys()].find((one) => !asked.has(one));
		if (at === undefined) break;
		asked.add(at);
		if (!inScope(at)) {
			leave.add(at);
			continue;
		}
		const one = await askAfter(state, at, scope.signal);
		if (!one) continue;
		if ("judged" in one) judged.push(one.judged);
		else leave.add(one.overtaken);
		if (one.problem) problems.push(one.problem);
	}
	const failure = problems.length > 0 ? { problems } : undefined;
	return { failure, judged, leave };
}

/**
 * Ask git after the failed run of the project at `root`, retiring it
 * when its tree has moved on. Only the run still recorded once git
 * answers counts: one an edit or a clean verify cleared meanwhile is
 * gone, and one recorded meanwhile is asked about in turn. Overtaken
 * past the bound, the newest holds the commit as it was recorded,
 * since verify fingerprinted it last, and git isn't asked again.
 */
async function askAfter(
	state: VerificationState,
	root: string,
	signal?: AbortSignal,
): Promise<Asked> {
	for (let tries = 0; tries < JUDGED_AT_MOST; tries++) {
		const run = state.failedRuns.get(root);
		if (!run) return undefined;
		const standing = await standingOf(run, signal);
		if (state.failedRuns.get(root) !== run) continue;
		if (standing === "moved") state.failedRuns.delete(root);
		const judged = { run, standing };
		return standing === "same"
			? { judged, problem: unchanged(run) }
			: { judged };
	}
	const newest = state.failedRuns.get(root);
	return newest
		? { overtaken: root, problem: recordedMeanwhile(newest) }
		: undefined;
}

/** What a commit is told of a failed run whose tree git says is the same. */
function unchanged(run: FailedRun): string {
	return (
		`${run.command} failed in ${run.root}, and nothing there has ` +
		"changed since. Run verify again once it is fixed."
	);
}

/** What a commit is told of a failed run recorded while its check ran. */
function recordedMeanwhile(run: FailedRun): string {
	return (
		`${run.command} failed in ${run.root} while this commit was ` +
		"checked. Run verify again once it is fixed."
	);
}

/**
 * What a commit is told, confirmed now, settling the state's outcome
 * from the same answers when it was failing or now fails. A project
 * whose runs were overtaken past the bound is asked about no more: its
 * newest run holds the commit as it was recorded. Nor is a project
 * outside the commit's repository: the next verify's settle asks after
 * it.
 */
export async function commitCheck(
	state: VerificationState,
	scope: VerificationScope,
	backend: DiagnosticsBackend | undefined,
): Promise<VerificationFailure | undefined> {
	const { failure, judged, leave } = await failureNow(state, scope, backend);
	if (state.outcome === "failing" || failure) {
		state.outcome = await settle(state, judged, scope.signal, leave);
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
 * The outcome for what the state knows now, retiring each failed run
 * whose tree has moved on, so the status line is no staler than the
 * answer a commit would get. A run `judged` already answers for is not
 * asked about again, nor any run of a project in `leave`, and git
 * stops being asked once `signal` fires. Projects are asked about one
 * at a time, as a commit's check asks.
 */
export async function settle(
	state: VerificationState,
	judged: readonly Judged[] = [],
	signal?: AbortSignal,
	leave: ReadonlySet<string> = new Set(),
): Promise<"clean" | "failing"> {
	const runs = [...state.failedRuns.values()].filter(
		(run) => !leave.has(run.root),
	);
	for (const run of runs) {
		const standing =
			judged.find((one) => one.run === run)?.standing ??
			(await standingOf(run, signal));
		// Retired only if it is still the one asked about once git answers.
		if (standing === "moved" && state.failedRuns.get(run.root) === run) {
			state.failedRuns.delete(run.root);
		}
	}
	return outcomeOf(state);
}

/** The outcome for what the state knows, asking nobody. */
function outcomeOf(state: VerificationState): "clean" | "failing" {
	return state.known.size > 0 || state.failedRuns.size > 0
		? "failing"
		: "clean";
}
