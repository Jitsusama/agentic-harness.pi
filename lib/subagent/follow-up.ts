/**
 * Asking a reviewer again, on the session it already has.
 *
 * Two follow-ups: a resume after a transient drop, and a wrap-up that
 * asks a reviewer we stopped for what it had found. Each is one more pi
 * process on the first run's session, under its own id, folded into the
 * first run's result. They change when what a stopped or dropped run is
 * owed does, which is apart from how any run is started or read.
 */

import type { ReviewerTerminalState } from "./artifacts.ts";
import { composeArgs } from "./launch.ts";
import { describeReviewerError } from "./reviewer-error.ts";
import type {
	ReviewerUsage,
	RunPiResult,
	RunReviewerOptions,
	RunReviewerResult,
	WrapUpRequest,
} from "./run-contract.ts";

/**
 * Stops worth asking about.
 *
 * A clock took a working reviewer away, so what it had is still worth
 * having. Cancelled is not here because somebody asked for the work
 * to stop, and parent-exit is not because there is nothing left to
 * ask with.
 */
export const WORTH_ASKING: ReadonlySet<ReviewerTerminalState> =
	new Set<ReviewerTerminalState>([
		"timeout",
		"idle-timeout",
		// The state that exists to be asked. A soft deadline stops a
		// healthy run for no other purpose, so leaving it out here would
		// take the reviewer's remaining time and give nothing back.
		"soft-deadline",
	]);

/**
 * What to say to a reviewer that ran out of time.
 *
 * Every line of this is aimed at one failure: a reviewer that treats
 * being resumed as permission to carry on working, meets the same wall
 * and costs the round a second time for nothing. It is asked for what
 * it has already formed, in the shape the contract asks for, and told
 * that a short answer is the right answer.
 */
const WRAP_UP_PROMPT =
	"You ran out of time and were stopped. Do not investigate further, do " +
	"not read any more files and do not continue the work: there is no " +
	"budget left for it, and anything you start now will be cut off again. " +
	"Reply now, in the JSON shape your instructions asked for, with only the " +
	"findings you had already formed. Leave out anything you were still " +
	"checking. A short answer of what you are sure of is exactly what is " +
	"wanted here, and is worth far more than nothing, which is what the " +
	"round gets otherwise.";

/**
 * How long a wrap-up gets.
 *
 * Small on purpose. This is a reviewer writing down what it already
 * knows, so it needs a fraction of a review, and a generous budget here
 * would hand a reviewer that ignored the prompt enough room to start
 * the whole investigation again.
 */
export const WRAP_UP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How much of a reviewer's wall clock is kept back for its answer.
 *
 * The difference between asking and taking. Without a reserve a
 * reviewer investigates until the wall clock kills it, and the wrap-up
 * then runs on time nobody budgeted, after a stop that has already
 * been recorded as one. With it, the reviewer is stopped early and
 * deliberately, and the time it did not spend investigating is the
 * time it has to answer in.
 *
 * The round costs the same either way. What changes is that the
 * reviewer is asked while there is still something to ask with.
 */
export function wrapUpReserve(
	options: Pick<RunReviewerOptions, "autoResume" | "wrapUpReserveMs">,
): number | undefined {
	// A run nobody can resume cannot be wrapped up, so stopping it
	// early would take time away and give nothing back. That is the
	// fleet path, which opts out of autoResume and stays ephemeral.
	if (options.autoResume === false) return undefined;
	// Zero switches it off, which is what the documentation promises
	// and what somebody who wants the old behaviour will reach for.
	// Left to `??` it would have read as absent and handed back the
	// default, so the off switch would have turned it on.
	if (options.wrapUpReserveMs === 0) return undefined;
	return options.wrapUpReserveMs ?? WRAP_UP_TIMEOUT_MS;
}

/**
 * How long the wrap-up itself may run.
 *
 * The same function that decides what to keep back, called again
 * where it is spent, because these are one number and were briefly
 * two. Taking the reserve uncapped and spending it clamped at five
 * minutes meant a configured `answerMs` of ten minutes took ten
 * minutes of investigation away and handed five of them back. The
 * defaults hid it exactly: both constants were five minutes, written
 * in two modules with nothing joining them.
 *
 * Still never longer than the caller's whole budget, which only binds
 * when no soft deadline fired, since one that did already proved the
 * reserve was the smaller number.
 */
function wrapUpBudget(
	options: Pick<
		RunReviewerOptions,
		"autoResume" | "wrapUpReserveMs" | "timeoutMs"
	>,
): number {
	const reserve = wrapUpReserve(options) ?? WRAP_UP_TIMEOUT_MS;
	return Math.min(reserve, options.timeoutMs ?? reserve);
}

/**
 * A suffix, so a wrap-up does not overwrite the record of the stop.
 *
 * The artifacts directory is derived from the run and reviewer ids
 * alone, and the result file is written by rename, so reusing both ids
 * replaces the stopped run's own record with one saying the reviewer
 * completed. That record is the evidence this whole line of work
 * exists to keep, and recovery reads it.
 */
export const WRAP_UP_SUFFIX = "+wrapup";

/** The same, for a resume, and for the same reason. */
export const RESUME_SUFFIX = "+resume";

/** What a wrap-up is asked and on what clocks, whoever sends it. */
export function wrapUpAsked(
	options: Pick<
		RunReviewerOptions,
		| "reviewer"
		| "systemPrompt"
		| "isolated"
		| "ignoreProject"
		| "autoResume"
		| "wrapUpReserveMs"
		| "timeoutMs"
		| "idleTimeoutMs"
	>,
	sessionPath: string,
	extraExtensions: readonly string[],
	extraSkills: readonly string[],
): WrapUpRequest {
	const args = composeArgs({
		spec: options.reviewer,
		prompt: WRAP_UP_PROMPT,
		systemPrompt: options.systemPrompt,
		isolated: options.isolated,
		// A fenced session's child reopened is still one whose folder's
		// `.pi` a fenced command may have written.
		ignoreProject: options.ignoreProject,
		resumeSessionPath: sessionPath,
		...(extraExtensions.length > 0 ? { extraExtensions } : {}),
		...(extraSkills.length > 0 ? { extraSkills } : {}),
	});
	// Never longer than the caller allowed, and never shorter on the
	// idle clock than the wall it runs under. Shortening an idle clock
	// on its own is how six rounds of working reviewers were killed:
	// silence is not idleness, and a reviewer composing a long answer
	// goes quiet while it does.
	const wall = wrapUpBudget(options);
	return {
		reviewerId: `${options.reviewer.id}${WRAP_UP_SUFFIX}`,
		args,
		timeoutMs: wall,
		idleTimeoutMs: Math.min(options.idleTimeoutMs ?? wall, wall),
	};
}

/**
 * The wrap-up a reviewer nobody waits for is owed, for its supervisor
 * to send when a clock stops it. The session it will resume is not
 * known until then, so the supervisor puts it in place of this one.
 */
export function detachedWrapUp(
	options: Parameters<typeof wrapUpAsked>[0],
	extraExtensions: readonly string[],
	extraSkills: readonly string[],
): WrapUpRequest {
	return wrapUpAsked(
		options,
		SESSION_NOT_YET_KNOWN,
		extraExtensions,
		extraSkills,
	);
}

/**
 * Where the session goes in a detached wrap-up's arguments, until the
 * supervisor knows it. Never empty, or composeArgs would leave out the
 * `--session` it marks.
 */
const SESSION_NOT_YET_KNOWN = "-";

/** Ask a stopped reviewer to hand over what it already has. */
export async function dispatchWrapUp(
	options: RunReviewerOptions,
	sessionPath: string,
	extraExtensions: readonly string[],
	extraSkills: readonly string[],
): Promise<RunPiResult> {
	const asked = wrapUpAsked(options, sessionPath, extraExtensions, extraSkills);
	return options.runPi({
		args: [...asked.args],
		cwd: options.cwd,
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.runId ? { runId: options.runId } : {}),
		reviewerId: asked.reviewerId,
		timeoutMs: asked.timeoutMs,
		idleTimeoutMs: asked.idleTimeoutMs,
		signal: options.signal,
		onEvent: options.onEvent,
	});
}

/**
 * Fold a wrap-up into the run it belongs to.
 *
 * The stop stands. The reviewer handed over what it had; it did not
 * finish the review, and reporting the pass as complete would put a
 * fresh lie exactly where the old one was. What changes is that the
 * round now has the answer as well as the interruption.
 *
 * Both texts survive, apart rather than joined. A wrap-up can come
 * back empty or cut off in its turn, and the fragment is then the only
 * answer there is; joining them defeats every branch of the reader
 * that has to parse the result.
 */
export function mergeWrapUpOutcome(
	stopped: RunReviewerResult,
	wrapUp: RunReviewerResult,
): RunReviewerResult {
	const answered = wrapUp.finalAssistantText.trim() !== "";
	const had = stopped.finalAssistantText.trim() !== "";
	const usage = sumReviewerUsage(stopped.usage, wrapUp.usage);
	const note =
		wrapUp.finalAssistantText.trim() === ""
			? "Asked this reviewer for the findings it had when it was stopped; it answered with nothing, so this is what it had written at the time."
			: "This reviewer was stopped before it finished and was asked for the findings it had already formed. What follows is that answer, not a completed review.";
	return {
		...stopped,
		finalAssistantText: answered
			? wrapUp.finalAssistantText
			: stopped.finalAssistantText,
		...(answered && had
			? { priorAssistantText: stopped.finalAssistantText }
			: {}),
		...(answered ? { wrappedUp: true } : {}),
		// Both runs' journals. The wrap-up runs in the same reviewer
		// directory's sibling, so these are two files, and a finding
		// recorded before the stop is not superseded by one recorded
		// after it. The round dedupes.
		...(stopped.journal || wrapUp.journal
			? { journal: [...(stopped.journal ?? []), ...(wrapUp.journal ?? [])] }
			: {}),
		warnings: [...stopped.warnings, note, ...wrapUp.warnings],
		sessionIds: joinSessions(stopped.sessionIds, wrapUp.sessionIds),
		...(usage ? { usage } : {}),
	};
}

/**
 * The sessions two processes of one run billed under, in order, each
 * once: a resume continues the first attempt's session file, so its
 * process announces the same id again. Unknown if either half is,
 * because a list missing a session reads as the whole bill.
 */
function joinSessions(
	first: readonly string[] | null,
	second: readonly string[] | null,
): readonly string[] | null {
	return first === null || second === null
		? null
		: [...new Set([...first, ...second])];
}

/**
 * The continuation prompt for a resumed reviewer. The prior
 * investigation is already in the session, so the resume
 * must not repeat it; it only has to finish and verify.
 */
const RESUME_CONTINUATION_PROMPT =
	"Your previous turn was interrupted before you finished, likely by a " +
	"dropped model stream. Do not restart your investigation or repeat any " +
	"tool calls; your prior work is already in this session. Review what you " +
	"have and call verify_output with your complete result now.";

/**
 * Resume a dropped reviewer from its persisted session. Same
 * model, tools, extensions and system prompt as the initial
 * run, continuing the same session, which the session path
 * carries rather than the ids.
 *
 * Under its own reviewer id, so it keeps its own artifacts
 * rather than writing over the attempt it is recovering.
 */
export async function dispatchResume(
	options: RunReviewerOptions,
	sessionPath: string,
	extraExtensions: readonly string[],
	extraSkills: readonly string[],
): Promise<RunPiResult> {
	const args = composeArgs({
		spec: options.reviewer,
		prompt: RESUME_CONTINUATION_PROMPT,
		systemPrompt: options.systemPrompt,
		isolated: options.isolated,
		ignoreProject: options.ignoreProject,
		resumeSessionPath: sessionPath,
		...(extraExtensions.length > 0 ? { extraExtensions } : {}),
		...(extraSkills.length > 0 ? { extraSkills } : {}),
	});
	return options.runPi({
		args,
		cwd: options.cwd,
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.runId ? { runId: options.runId } : {}),
		// Its own directory, like the wrap-up's. It used to share the
		// first attempt's, which was harmless while the only shared file
		// was a result nobody had written yet. It stopped being harmless
		// when a journal moved in: the supervisor clears that file before
		// every spawn, so a resume deleted what the attempt it is
		// recovering had recorded, and the continuation prompt tells the
		// reviewer not to make a tool call twice, so it never came back.
		reviewerId: `${options.reviewer.id}${RESUME_SUFFIX}`,
		signal: options.signal,
		onEvent: options.onEvent,
		...(options.timeoutMs !== undefined
			? { timeoutMs: options.timeoutMs }
			: {}),
		...(options.idleTimeoutMs !== undefined
			? { idleTimeoutMs: options.idleTimeoutMs }
			: {}),
	});
}

/**
 * Fold a resume attempt into the initial outcome. The resume
 * is authoritative for the final state, and its usage is
 * added to the initial run's so the reported cost is the
 * true total. A note records whether the resume recovered
 * the reviewer or also failed.
 */
export function mergeResumeOutcome(
	initial: RunReviewerResult,
	resume: RunReviewerResult,
): RunReviewerResult {
	const recovered =
		resume.error === undefined && resume.verification?.ok !== false;
	const note = recovered
		? "Resumed the reviewer from its persisted session after a transient error."
		: "Auto-resume from the persisted session also failed after the transient error; not retried further.";
	const usage = sumReviewerUsage(initial.usage, resume.usage);
	// On a clean recovery the initial attempt's transient-error
	// warning is no longer something the user must act on, and
	// leaving it in reads as though the reviewer failed. Drop
	// just that one warning (regenerated exactly, not
	// fuzzy-matched), keeping any other warnings the first
	// attempt produced.
	const initialError = initial.error;
	const initialWarnings =
		recovered && initialError !== undefined
			? initial.warnings.filter(
					(warning) => warning !== describeReviewerError(initialError),
				)
			: initial.warnings;
	return {
		...resume,
		// Both attempts' journals. A resume replaces the attempt, but
		// not what the attempt wrote down: the continuation prompt tells
		// the reviewer not to repeat tool calls it has already made, so
		// a finding recorded before the drop is never recorded again.
		// Losing it here would take findings from the one path that
		// exists because something went wrong mid-investigation.
		...(initial.journal || resume.journal
			? { journal: [...(initial.journal ?? []), ...(resume.journal ?? [])] }
			: {}),
		warnings: [...initialWarnings, note, ...resume.warnings],
		sessionIds: joinSessions(initial.sessionIds, resume.sessionIds),
		...(usage ? { usage } : {}),
	};
}

/** Sum two optional usage totals, channel by channel. */
function sumReviewerUsage(
	a: ReviewerUsage | undefined,
	b: ReviewerUsage | undefined,
): ReviewerUsage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		tokens: {
			input: a.tokens.input + b.tokens.input,
			output: a.tokens.output + b.tokens.output,
			cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
			cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
			total: a.tokens.total + b.tokens.total,
		},
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}
