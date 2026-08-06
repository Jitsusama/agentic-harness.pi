/**
 * What a runner's outcome means to a round.
 *
 * The adapter between two libraries that must not know about each
 * other: `lib/subagent` says how a subprocess ended, `lib/review` says
 * what a round makes of it, and this extension is the only thing that
 * composes them.
 *
 * The distinction it exists to draw is between a reviewer we stopped
 * and a reviewer that answered badly. Six council rounds were reported
 * as the second when every one of them was the first, and the cost of
 * getting it the wrong way round is not cosmetic: it sends somebody to
 * fix an output contract that was never broken, and it makes retrying
 * look reasonable when the retry is guaranteed to hit the same wall.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskAnswer, AskLimit, AskStop } from "../../lib/review/index.js";
import type {
	PiInstall,
	ReviewerArtifactsStore,
	ReviewerTerminalState,
	RunPi,
	RunReviewerResult,
} from "../../lib/subagent/index.js";
import {
	mergeResumeOutcome,
	mergeWrapUpOutcome,
} from "../../lib/subagent/index.js";
import {
	createSupervisorRunPi,
	type SupervisorSpawnFn,
} from "../../lib/subagent/runpi/supervisor.js";
import { budgetForLimit } from "./budget.js";

/**
 * Which of our limits took the reviewer away.
 *
 * Only the states that mean "it was working and we ended it" appear
 * here. A run that completed, failed or errored was not stopped by a
 * limit, and inventing one for it would be a lie in the other
 * direction.
 */
const LIMITS: Partial<Record<ReviewerTerminalState, AskLimit>> = {
	timeout: "wall-clock",
	"idle-timeout": "idle",
	"output-limit": "output",
	"soft-deadline": "soft-deadline",
	cancelled: "cancelled",
	"parent-exit": "parent-exit",
};

/**
 * How the supervisor words each stop, so its sentence can be found
 * among the warnings and preferred over anything reconstructed here.
 *
 * Matched per limit rather than by one loose pattern, so a run that
 * carries an unrelated warning mentioning idleness cannot have it
 * quoted as the reason a wall clock fired.
 */
const SAYS: Record<AskLimit, RegExp> = {
	"wall-clock": /timed out/i,
	idle: /idle/i,
	output: /output limits/i,
	"soft-deadline": /soft deadline/i,
	cancelled: /cancelled/i,
	"parent-exit": /parent process/i,
};

/**
 * The runner a round's reviewers run on.
 *
 * Supervised, not fire-and-forget, and that is the whole point: the
 * supervised runner writes a transcript, a stderr log and a resumable
 * session per reviewer under the round that paid for them, while the
 * fire-and-forget one keeps its output in memory and drops it.
 *
 * A named function rather than a call inlined into the ask closure so
 * the choice is something a test can hold. The wiring used to be
 * checked by grepping this file's source, which proves the words are
 * present and nothing about what runs.
 */
export function reviewerRunner(
	piInstall: PiInstall,
	stateDir: string,
	spawn?: SupervisorSpawnFn,
): RunPi {
	return createSupervisorRunPi({
		piInstall,
		stateDir,
		...(spawn === undefined ? {} : { spawn }),
	});
}

/**
 * Keep what a reviewer said, verbatim, and say where it went.
 *
 * The answer that parsed is already represented by its findings. The
 * one worth keeping is the one that did not, because it is the only
 * record of what the round paid for, and without it the sole way to
 * find out what a reviewer found is to buy the answer again.
 *
 * Separate from the runner's own transcript on purpose. That holds the
 * whole event stream, megabytes of it, and belongs to the runner's
 * retention; this is the few kilobytes somebody actually wants to read,
 * and a finding's provenance has to outlive the runner's housekeeping.
 */
export async function keepAnswer(
	root: string,
	runId: string,
	participantId: string,
	text: string,
): Promise<string> {
	const dir = join(root, safeSegment(runId));
	await mkdir(dir, { recursive: true });
	const at = join(dir, `${safeSegment(participantId)}.txt`);
	await writeFile(at, text, "utf8");
	return at;
}

/**
 * One path segment, from a name that came out of config.
 *
 * Ids are whatever somebody wrote, so one carrying a slash would
 * otherwise write outside its round, or fail a whole round over a
 * naming choice.
 */
function safeSegment(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return safe === "" ? "_" : safe;
}

/**
 * What one reviewer left behind, read back as an answer.
 *
 * The whole point of a round writing itself down before it asks
 * anybody: a session that died holding a council left every reviewer's
 * work here, and until now nothing could turn it back into findings.
 *
 * Reads `result.json` and nothing else, which is what makes this
 * cheap and what keeps it honest. The supervisor already folded the
 * reviewer's journal and its journal warnings into that file, so
 * collecting needs no second reader of the journal: a second one
 * would drift from the first, and this package has paid for that
 * mistake once already.
 */
export async function answerLeftBehind(
	store: ReviewerArtifactsStore,
	runId: string,
	participantId: string,
	budget?: { timeoutMs: number; idleTimeoutMs: number },
): Promise<LeftBehind> {
	try {
		const base = await resultIn(store, runId, participantId);
		if (base === undefined) return { kind: "missing" };
		// A stopped reviewer's work spans up to three directories. The
		// wrap-up and the resume are spawned under suffixed ids so
		// neither overwrites the record of the stop, and the live path
		// folds them together in memory and never writes the merge back.
		// Reading only the base is therefore keeping the fragment and
		// discarding the answer, in the shape an interrupted round most
		// often has.
		const wrapUp = await resultIn(store, runId, `${participantId}+wrapup`);
		const merged =
			wrapUp === undefined ? base : mergeWrapUpOutcome(base, wrapUp);
		const resume = await resultIn(store, runId, `${participantId}+resume`);
		const entire =
			resume === undefined ? merged : mergeResumeOutcome(merged, resume);
		return { kind: "answer", answer: answerFromReviewer(entire, budget) };
	} catch (error) {
		// One unreadable file costs one participant. Letting it out
		// would abandon the whole collect over a single directory,
		// leave the round open, and send every later attempt into the
		// same file with nothing naming which of seven it was.
		return {
			kind: "unreadable",
			why: error instanceof Error ? error.message : String(error),
		};
	}
}

/** What one reviewer's directories turned out to hold. */
export type LeftBehind =
	| { kind: "answer"; answer: AskAnswer }
	| { kind: "missing" }
	| { kind: "unreadable"; why: string };

/** One result file, read back as the runner would have returned it. */
async function resultIn(
	store: ReviewerArtifactsStore,
	runId: string,
	reviewerId: string,
): Promise<RunReviewerResult | undefined> {
	const { resultPath } = store.paths(runId, reviewerId);
	const read = await store.readJson<Partial<RunReviewerResult>>(resultPath);
	if (read === null) return undefined;
	// A file that parses but carries neither an answer nor a journal is
	// not an empty review, it is a file whose shape this cannot read.
	// Filling it in would hand back a reviewer that read the change and
	// had no complaint, settle the round on it, and hide the loss for
	// good.
	if (read.finalAssistantText === undefined && read.journal === undefined) {
		throw new Error(
			`${resultPath} holds no answer and no recorded findings, so there is nothing in it to read.`,
		);
	}
	return whole(read, reviewerId);
}

/**
 * A result file, made to keep the promises the type makes.
 *
 * Read as `Partial` and filled, rather than asserted whole. The file
 * was written by a different process, possibly a different version of
 * it, possibly while being killed, and a cast is a claim about
 * something none of that can be asked to honour. Asserted whole, a
 * missing warnings list is not a wrong answer but a thrown one, in the
 * middle of recovering the work a round already paid for.
 */
function whole(
	read: Partial<RunReviewerResult>,
	participantId: string,
): RunReviewerResult {
	return {
		...read,
		reviewerId: read.reviewerId ?? participantId,
		// Not zero. Zero is the most optimistic value there is and it
		// combines with an empty answer to read as a healthy reviewer
		// that had no complaint, which is the one thing that must never
		// be invented. A file with no exit code did not exit well.
		exitCode: read.exitCode ?? 1,
		finalAssistantText: read.finalAssistantText ?? "",
		// The supervised runner writes a stderr tail rather than this,
		// so a result file legitimately has no stderr at all.
		stderr: read.stderr ?? "",
		warnings: [...(read.warnings ?? [])],
	};
}

/**
 * Read one reviewer's run as an answer, a stop, or a failure.
 *
 * The budget is passed in because the run cannot say what it was: it
 * knows it was killed, not what it was allowed. Recording it is what
 * lets a later retry tell whether anything has moved.
 */
export function answerFromReviewer(
	result: RunReviewerResult,
	budget?: { timeoutMs: number; idleTimeoutMs: number },
): AskAnswer {
	const stopped = stopFrom(result, budget);
	if (stopped !== undefined) {
		return {
			text: result.finalAssistantText,
			stopped,
			// Carried through rather than joined to the answer, so the
			// round can read both and keep whichever found more.
			...(result.priorAssistantText === undefined
				? {}
				: { earlierText: result.priorAssistantText }),
			...recordedBy(result),
			...notesOn(undefined, result),
			...usageOf(result),
		};
	}

	// No limit fired, so an empty non-zero run that recorded nothing is
	// a run that never produced anything: the model was unavailable, the
	// install was stale, the process died. That is a failure, and it is
	// the only thing left that still is one. A run that wrote findings
	// down before dying produced something, whatever its exit code, and
	// calling that a failure would throw the findings away to keep the
	// classification tidy.
	const recorded = recordedBy(result);
	const died = result.exitCode !== 0 && result.finalAssistantText.trim() === "";
	if (died && recorded.recorded === undefined) {
		return { failure: failureFrom(result) };
	}

	return {
		text: result.finalAssistantText,
		...recorded,
		// Keeping the findings is not the same as pretending it went
		// well. failureFrom is the only reader of the exit code, the
		// stderr tail and the stale-install advisory, and reclassifying
		// away from a failure made it unreachable for exactly the run
		// that needs it: exit 1, no answer, findings on disk, filed as a
		// participant that simply found one thing.
		...notesOn(died ? failureFrom(result) : undefined, result),
		...usageOf(result),
	};
}

/** What the round has to say that the answer cannot show. */
function notesOn(
	died: string | undefined,
	result: RunReviewerResult,
): { notes?: string[] } {
	const notes = [
		...(died === undefined ? [] : [died]),
		...(result.journalWarnings ?? []),
	];
	return notes.length === 0 ? {} : { notes };
}

/** What the reviewer wrote down as it worked, if anything. */
function recordedBy(result: RunReviewerResult): { recorded?: unknown[] } {
	return result.journal === undefined || result.journal.length === 0
		? {}
		: { recorded: [...result.journal] };
}

/** The stop this run represents, when a limit ended it. */
function stopFrom(
	result: RunReviewerResult,
	budget?: { timeoutMs: number; idleTimeoutMs: number },
): AskStop | undefined {
	const limit = result.state === undefined ? undefined : LIMITS[result.state];
	if (limit === undefined) return undefined;
	const ran = budgetFor(limit, budget);
	return {
		limit,
		detail: detailFrom(result, limit),
		...(ran === undefined ? {} : { budgetMs: ran }),
	};
}

/** The clock this limit ran out of, where it is a clock at all. */
function budgetFor(
	limit: AskLimit,
	budget?: { timeoutMs: number; idleTimeoutMs: number },
): number | undefined {
	// The mapping belongs to whatever judges a retry against it, and
	// keeping a second copy here is how the two come to disagree about
	// which number a limit means.
	return budget === undefined ? undefined : budgetForLimit(limit, budget);
}

/**
 * Why it stopped, preferring the runner's own words.
 *
 * The supervisor writes a warning naming the budget and the signal,
 * which is more use than anything reconstructed here: it carries the
 * number somebody has to change.
 */
function detailFrom(result: RunReviewerResult, limit: AskLimit): string {
	const said = result.warnings.find((warning) => SAYS[limit].test(warning));
	const why = said ?? `Stopped at the ${limit} limit.`;
	// The round replaces a stopped participant's warnings with a
	// sentence of its own, so a note left in the run's warnings never
	// reaches a reader. This is the one line that does.
	return result.wrappedUp === true
		? `${why} It was then asked for the findings it had already formed, and this is that answer rather than a finished review.`
		: why;
}

/** What to say about a run that produced nothing at all. */
function failureFrom(result: RunReviewerResult): string {
	const said = result.error?.message ?? result.stderr.trim();
	return said === "" || said === undefined
		? `${result.reviewerId} exited ${result.exitCode} without answering.`
		: said;
}

/** What it cost, flattened to the two numbers a round records. */
function usageOf(result: RunReviewerResult): {
	usage?: { tokens: number; cost: number };
} {
	if (result.usage === undefined) return {};
	return {
		usage: {
			tokens: result.usage.tokens.total,
			cost: result.usage.cost.total,
		},
	};
}
