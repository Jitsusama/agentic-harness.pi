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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AskAnswer,
	AskLimit,
	AskRun,
	AskStop,
} from "../../lib/review/index.js";
import type {
	PiInstall,
	ProcessFacts,
	ReviewerArtifactsStore,
	ReviewerTerminalState,
	RunPi,
	RunReviewerResult,
} from "../../lib/subagent/index.js";
import {
	detectStaleInstallInStderr,
	mergeResumeOutcome,
	mergeWrapUpOutcome,
	RESUME_SUFFIX,
	STALE_RUNTIME_WARNING_PREFIX,
	supervisorStanding,
	systemFacts,
	WRAP_UP_SUFFIX,
} from "../../lib/subagent/index.js";
import {
	JOURNAL_SAYS,
	journalWarnings,
	parseJournal,
} from "../../lib/subagent/runpi/journal.mjs";
import {
	createSupervisorRunPi,
	createSupervisorStartPi,
	type StartPi,
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
	"supervisor-lost": "supervisor-lost",
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
	// No supervisor wrote a sentence about this one, because the
	// supervisor is what is missing. The reconstructed wording is all
	// there is, and matching nothing is how it gets used.
	"supervisor-lost": /supervisor/i,
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

/** The same supervised runner, for a reviewer nobody will wait for. */
export function reviewerStarter(
	piInstall: PiInstall,
	stateDir: string,
	spawn?: SupervisorSpawnFn,
): StartPi {
	return createSupervisorStartPi({
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
 * A recovered answer, with its own words kept somewhere they last.
 *
 * The live path keeps every answer it reads and the collect path kept
 * none, so a recovered reviewer's answer was linked from nothing. That
 * is the stronger case of the two: a collected round's reviewer
 * directories are what the transcript sweep reclaims once the round
 * stops being open, seven days on, while nothing sweeps the archive at
 * all.
 *
 * Never throws, and never costs the answer. A full disk is a reason to
 * lose the archive, not a reason to lose findings a reviewer already
 * paid for.
 */
export async function archivedAnswer(
	root: string,
	run: AskRun,
	participantId: string,
	answer: AskAnswer,
): Promise<AskAnswer> {
	// A failure has no text to keep, and nothing to point at from an
	// outcome that records no findings.
	if ("failure" in answer) return answer;
	// Nor for a participant already filed. A collect that died halfway
	// leaves outcomes on the ledger carrying archives of their own, and
	// the round hands those back untouched, so anything written here
	// for them is written and then dropped.
	if (run.outcomes.some((one) => one.participantId === participantId)) {
		return answer;
	}
	// Both halves, for a reviewer that was stopped and asked again:
	// findings are harvested from each, so keeping only the second
	// leaves an archive that does not contain what the round filed.
	const text =
		answer.earlierText === undefined
			? answer.text
			: `${answer.earlierText}\n\n${STOPPED_HERE}\n\n${answer.text}`;
	// An empty answer would write an empty file, and an outcome
	// pointing at one sends a reader to look at nothing.
	if (text.trim() === "") return answer;
	try {
		return {
			...answer,
			answerPath: await keepAnswer(root, run.id, participantId, text),
		};
	} catch {
		return answer;
	}
}

/** What separates the two halves of a stopped reviewer's archive. */
export const STOPPED_HERE = "--- stopped here; asked again for what it had ---";

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
 * Which reviewer, if any, a live supervisor is still holding.
 *
 * An open mark says a round started and did not finish, which is the
 * same on the ledger for a dead session and for a council running
 * right now in another window. Collecting a live round reads the
 * reviewers that have finished, files their findings, records the
 * rest as having left nothing, and settles it. The session still
 * running then finishes and records the whole round again: every
 * early finding filed twice, and a settled round that says its
 * reviewers found nothing.
 *
 * Every reviewer's directories are asked, not just the one named on
 * the roster. A wrap-up and a resume are supervised runs of their
 * own, with their own leases, and a round can be down to nothing but
 * a wrap-up still writing: asking only the base id reads no live
 * lease and calls the round free.
 */
/**
 * Why this round must not be collected yet, when a supervisor still
 * holds it.
 *
 * Beside the read it is built on rather than private to the tool,
 * because the sentence is the behaviour: a collect that lands while
 * somebody is still writing files the findings of whoever has
 * finished and then lets the other session file them again. Kept
 * private, the only thing reachable from a test was the read, and a
 * case could say it proved a refusal while asserting the input to
 * one.
 */
export async function whyNotYet(
	artifacts: ReviewerArtifactsStore,
	held: { id: string; participants: readonly { id: string }[] },
	facts: ProcessFacts = systemFacts,
	now: number = Date.now(),
): Promise<string | undefined> {
	const holder = await heldByLiveSupervisor(
		artifacts,
		held.id,
		held.participants.map((participant) => participant.id),
		facts,
		now,
	);
	if (holder === undefined) return undefined;
	return `${held.id} is still being run: ${holder.reviewerId} is held by a supervisor (pid ${holder.pid}) whose lease was renewed ${Math.round(holder.sinceMs / 1000)}s ago. Collecting now would file the findings of whoever has finished and then let that session file them again. Wait for it, or stop the round.`;
}

export async function heldByLiveSupervisor(
	store: ReviewerArtifactsStore,
	runId: string,
	reviewerIds: readonly string[],
	facts: ProcessFacts = systemFacts,
	now: number = Date.now(),
): Promise<{ reviewerId: string; pid: number; sinceMs: number } | undefined> {
	for (const reviewerId of reviewerIds) {
		for (const id of everyRunOf(reviewerId)) {
			const standing = await supervisorStanding(store, runId, id, facts, now);
			if (standing.kind === "running") {
				return { reviewerId: id, pid: standing.pid, sinceMs: standing.sinceMs };
			}
		}
	}
	return undefined;
}

/** Every directory one reviewer's work can be spread across. */
function everyRunOf(reviewerId: string): readonly string[] {
	return [
		reviewerId,
		`${reviewerId}${WRAP_UP_SUFFIX}`,
		`${reviewerId}${RESUME_SUFFIX}`,
	];
}

/**
 * What one reviewer left behind, read back as an answer.
 *
 * The whole point of a round writing itself down before it asks
 * anybody: a session that died holding a council left every reviewer's
 * work here, and until now nothing could turn it back into findings.
 *
 * Reads `result.json` wherever there is one, because the supervisor
 * has already folded the reviewer's journal and its journal warnings
 * into that file, and a second reading of the journal beside a first
 * would drift from it.
 *
 * Where there is no result at all, it reads the journal directly,
 * through the parser the supervisor itself uses. That is not a second
 * reader; it is the same one, reached by the only road left when the
 * supervisor is the thing that went missing. What comes back says so:
 * a reviewer whose supervisor was lost, carrying what it had written
 * down, never a reviewer that answered.
 */
export async function answerLeftBehind(
	store: ReviewerArtifactsStore,
	runId: string,
	participantId: string,
	budget?: { timeoutMs: number; idleTimeoutMs: number },
): Promise<LeftBehind> {
	try {
		const base = await resultIn(store, runId, participantId, true);
		if (base === undefined) return { kind: "missing" };
		// A stopped reviewer's work spans up to three directories. The
		// wrap-up and the resume are spawned under suffixed ids so
		// neither overwrites the record of the stop, and the live path
		// folds them together in memory and never writes the merge back.
		// Reading only the base is therefore keeping the fragment and
		// discarding the answer, in the shape an interrupted round most
		// often has.
		const wrapUp = await resultIn(
			store,
			runId,
			`${participantId}${WRAP_UP_SUFFIX}`,
		);
		const merged =
			wrapUp === undefined ? base : mergeWrapUpOutcome(base, wrapUp);
		const resume = await resultIn(
			store,
			runId,
			`${participantId}${RESUME_SUFFIX}`,
		);
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
	rescue = false,
): Promise<RunReviewerResult | undefined> {
	const { resultPath } = store.paths(runId, reviewerId);
	const read = await store.readJson<Partial<RunReviewerResult>>(resultPath);
	// No result file at all is the case the journal was built for, and
	// until now the only one it could not answer. The supervisor folds
	// the journal into its result, so a reviewer whose supervisor died
	// first has every finding it recorded sitting on disk with nothing
	// that reads it: collect said "missing", the round settled, and the
	// work was paid for and stranded. The reviewer writes that file
	// itself, so it survives its supervisor by construction.
	if (read === null) {
		// Only the base attempt. A wrap-up or a resume directory holding
		// nothing but a journal used to be skipped, and merging one in
		// is not additive: `mergeResumeOutcome` spreads the resume last,
		// so a journal-only stub would blank the first attempt's answer,
		// erase its error and have the round report a clean recovery
		// over the top of the text its findings were in.
		return rescue ? await whatItWroteDown(store, runId, reviewerId) : undefined;
	}
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
 * What a reviewer recorded, when nothing else about it survives.
 *
 * Built to look like the result its supervisor would have written,
 * because everything downstream already knows how to read one of
 * those. It reports an unclean exit and no answer, which is exactly
 * what happened: this reviewer never finished, and the round should
 * say so beside the findings it did manage to write down.
 */
async function whatItWroteDown(
	store: ReviewerArtifactsStore,
	runId: string,
	reviewerId: string,
): Promise<RunReviewerResult | undefined> {
	const { journalPath } = store.paths(runId, reviewerId);
	let raw: string;
	try {
		raw = await readFile(journalPath, "utf8");
	} catch (error) {
		// Absent is the ordinary case: this reviewer recorded nothing.
		// Anything else is a file that is there and cannot be read,
		// which is a different thing and must not be reported as an
		// empty one. The supervisor's own reader draws exactly this
		// line, and losing it here would turn a permissions problem
		// into a reviewer that had nothing to say.
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	}
	const counts = parseJournal(raw);
	const said = journalWarnings(counts, journalPath);
	// Not `entries.length === 0`. A reviewer killed while writing its
	// first entry leaves one truncated line, and a reviewer that pasted
	// an excerpt into a finding leaves a perfectly good line over the
	// cap: both parse to nothing, and both have a warning saying so and
	// naming where the file still is. Returning nothing here discards
	// the one sentence that says the round is short a finding, and
	// collect then reports the directory as empty with the file sitting
	// in it.
	if (counts.entries.length === 0 && said.length === 0) return undefined;
	return whole(
		{
			// The state no supervisor writes, because the supervisor is
			// what is missing. Without it `stopFrom` returns nothing, the
			// outcome carries neither a stop nor a failure, and the round
			// records a reviewer whose supervisor died as one that read
			// the change and answered: byte-identical on the ledger, and
			// counted as answered by every later reader.
			state: "supervisor-lost",
			...(counts.entries.length > 0 ? { journal: counts.entries } : {}),
			journalWarnings: [
				...said,
				`${JOURNAL_SAYS} ${reviewerId} left no result of its own, so this is what it had written down when its supervisor went away; the rest is at ${journalPath}`,
			],
		},
		reviewerId,
	);
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
	// An error counts as dying even on a clean exit code. A provider
	// drop is reported as the turn's error and the process can still
	// exit zero, and on the waiting path that hardly showed: a resume
	// was dispatched and usually recovered it. A detached reviewer has
	// nobody to resume it, so without this the round reads a real
	// transport failure as a reviewer that had nothing to say, and the
	// message naming what went wrong is discarded.
	const died =
		(result.exitCode !== 0 || result.error !== undefined) &&
		result.finalAssistantText.trim() === "";
	if (died && recorded.recorded === undefined) {
		const advisory = sessionWide(result);
		return {
			failure: failureFrom(result),
			...(advisory === undefined ? {} : { advisory }),
		};
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

/**
 * What is wrong with the session rather than with this reviewer.
 *
 * Two ways to learn the same thing, and the round needs both. The
 * health check refuses to spawn when an install path has gone, and
 * puts its sentence in the warnings; a child that got as far as
 * starting and then died on the same missing directory says so only
 * in its stderr, which the second detector reads. Watching for the
 * first alone means a round that crashed a hair later than the probe
 * expected is diagnosed as seven broken reviewers.
 *
 * Said as a fact rather than left in the prose. Only this side knows
 * the difference between a session that cannot spawn anything and a
 * reviewer that fell over, and a round should not have to guess it
 * back out of a message.
 */
function sessionWide(result: RunReviewerResult): string | undefined {
	const warned = result.warnings?.find((one) =>
		one.startsWith(STALE_RUNTIME_WARNING_PREFIX),
	);
	return warned ?? detectStaleInstallInStderr(result.stderr) ?? undefined;
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
