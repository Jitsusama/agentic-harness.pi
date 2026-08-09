/**
 * What bounds one reviewer's run, and which bound does which job.
 *
 * Two clocks answering two different questions, which is the whole
 * point of the file. Is this reviewer wedged, which is liveness, and
 * has it run long enough, which is a budget. One clock cannot answer
 * both, and using the wall clock to answer the first is what killed
 * working reviewers in six consecutive rounds.
 *
 * Separate from reading a reviewer's outcome because this is the half
 * that consults config, and because a new knob here has nothing to do
 * with a new terminal state there.
 */

import type { AskLimit, AskStop, Participant } from "../../lib/review/index.js";
import { DEFAULT_RUN_PI_TIMEOUT_MS } from "../../lib/subagent/runpi/spawn.js";
import { WRAP_UP_TIMEOUT_MS } from "../../lib/subagent/subagent.js";

/**
 * How long a reviewer may run before something stops it regardless.
 *
 * A backstop, not a budget. It exists for a reviewer that nothing else
 * will stop, and it is deliberately no tighter than the runner's own
 * default, because the review path knows nothing the runner does not
 * about how long honest work takes. The previous value was fifteen
 * minutes, chosen against a two-and-a-half-minute observation and
 * living in the panel module, and it killed working reviewers in six
 * consecutive rounds.
 */
export const REVIEWER_BACKSTOP_MS = DEFAULT_RUN_PI_TIMEOUT_MS;

/**
 * How long a reviewer may say nothing at all before it is wedged.
 *
 * This is the guard that actually earns its keep, and the reason a
 * generous backstop is safe. It fires on silence rather than on
 * effort, so it cannot punish a reviewer for having a lot to read.
 *
 * Held at the supervisor's own default rather than tightened: a
 * reviewer thinking hard against a large diff goes quiet for minutes,
 * and shortening this would recreate the bug in a different clock.
 */
export const REVIEWER_IDLE_MS = 15 * 60 * 1000;

/**
 * How much of the backstop is kept back for the answer.
 *
 * The third clock, and the only one that is not a limit. The other
 * two decide when a reviewer has to stop; this one decides when it is
 * asked to finish, which is a different question and a kinder one.
 *
 * Five minutes out of forty-five, because a wrap-up is a reviewer
 * writing down what it already knows rather than doing any more work.
 * Larger would buy nothing and would take real investigation time to
 * pay for it.
 */
export const REVIEWER_ANSWER_MS = WRAP_UP_TIMEOUT_MS;

/** What bounds one reviewer's run. */
export interface ReviewerBudget {
	timeoutMs: number;
	idleTimeoutMs: number;
	/** Kept back out of `timeoutMs` so the answer can be asked for. */
	wrapUpReserveMs: number;
}

/**
 * The clocks a limit can be measured against.
 *
 * Narrower than the whole budget on purpose. Judging a retry needs
 * the two numbers a limit can run out of and nothing else, and asking
 * for the full budget would make every caller invent a reserve it has
 * no opinion about just to ask the question.
 */
export type ReviewerClocks = Pick<
	ReviewerBudget,
	"timeoutMs" | "idleTimeoutMs"
> &
	Partial<Pick<ReviewerBudget, "wrapUpReserveMs">>;

/**
 * What bounds a round, taking any override from config.
 *
 * The fix for a bad constant is not a better constant. Both numbers
 * are guesses about somebody else's hardware, model and diff, so they
 * are overridable without patching source; a value that could not be
 * used is ignored rather than honoured, because a typo that produced a
 * zero budget would stop every reviewer the instant it started.
 */
/**
 * Which budget a limit is measured against, when it is one at all.
 *
 * Cancelled and parent-exit end a reviewer without any clock running
 * out, so there is no number to compare and asking again is the right
 * thing to do.
 */
const MEASURED_BY: Partial<
	Record<AskLimit, { of: keyof ReviewerClocks; named: string }>
> = {
	"wall-clock": { of: "timeoutMs", named: "backstopMs" },
	idle: { of: "idleTimeoutMs", named: "idleMs" },
};

/**
 * Where the soft deadline actually landed.
 *
 * Not in the table above, because it is the one limit that is not a
 * clock somebody set: it is the difference between two of them. Read
 * off `timeoutMs` alone it reported the backstop, so a reviewer
 * stopped at forty minutes was recorded as having hit forty-five, and
 * the refusal that quotes the number told the reader to raise a
 * budget the reviewer never reached.
 *
 * Two knobs move it, so the refusal names both.
 */
const SOFT: { named: string } = { named: "answerMs or backstopMs" };

/** The moment a soft deadline falls, given the clocks around it. */
function softDeadlineAt(budget: ReviewerClocks): number | undefined {
	const reserve = budget.wrapUpReserveMs;
	if (reserve === undefined || reserve <= 0) return undefined;
	const at = budget.timeoutMs - reserve;
	return at > 0 ? at : undefined;
}

/**
 * The clock a limit ran out of, where it is a clock at all.
 *
 * Shared with whatever records a stop, so the two cannot disagree
 * about which number belongs to which limit. They were written twice
 * and nothing joined them up.
 */
export function budgetForLimit(
	limit: AskLimit,
	budget: ReviewerClocks,
): number | undefined {
	if (limit === "soft-deadline") return softDeadlineAt(budget);
	const measure = MEASURED_BY[limit];
	return measure === undefined ? undefined : budget[measure.of];
}

/**
 * Limits that will land in the same place if nothing changes.
 *
 * A wall clock is arithmetic: a reviewer that ran to the wall runs to
 * it again, and the incident's failed retries all took 15.03 minutes
 * to prove it. An idle clock is not. It fires when a reviewer went
 * quiet, which is a hang, a slow tool, a provider stalling: things
 * that may simply not happen twice. Refusing that retry blocks the
 * one most likely to work, so it is allowed even though the number
 * has not moved.
 */
const REPEATS: ReadonlySet<AskLimit> = new Set<AskLimit>([
	"wall-clock",
	// Arithmetic for the same reason a wall clock is, and derived
	// from it: a reviewer asked to wrap up at forty minutes will be
	// asked again at forty minutes. Left out, a round of seven soft
	// deadlines would offer seven retries that all end identically,
	// which is the bill this work exists to stop paying.
	"soft-deadline",
]);

/**
 * Why asking this participant again would end the same way.
 *
 * A reviewer stopped by a clock will be stopped by that clock again if
 * nothing about it has moved, and the evidence is not ambiguous: every
 * failed retry in the round that prompted this work ran for 15.03
 * minutes and died identically. Three of them, at full price, to learn
 * what the first one had already said.
 *
 * So the refusal carries the number and the key that holds it. A
 * refusal that only says no leaves somebody hunting for the knob, and
 * the likeliest outcome of that is running the same retry again.
 *
 * Silent where it cannot know: an old round recorded no budget, and
 * refusing on a number nobody has would block every retry of every
 * round recorded before this existed.
 */
export function retryWouldRepeat(
	stopped: AskStop | undefined,
	budget: ReviewerClocks,
): string | undefined {
	if (stopped?.budgetMs === undefined) return undefined;
	if (!REPEATS.has(stopped.limit)) return undefined;
	const measure =
		stopped.limit === "soft-deadline" ? SOFT : MEASURED_BY[stopped.limit];
	if (measure === undefined) return undefined;
	const now = budgetForLimit(stopped.limit, budget);
	// A soft deadline that has since been switched off has no moment
	// to compare against, and that is a change: the reviewer will now
	// run to the wall instead, so the retry is a different question.
	if (now === undefined || now > stopped.budgetMs) return undefined;
	return (
		`This reviewer was not failing, it was stopped: it hit the ${stopped.limit} ` +
		`limit of ${stopped.budgetMs}ms and the limit is still ${now}ms, so asking ` +
		`again buys the same wall at the same price. Raise review.ask.${measure.named} ` +
		"past what it needed and ask again, or take what it did send: a stopped " +
		"reviewer's answer is kept, and the findings it finished are already read."
	);
}

/**
 * What bounds this one participant, given what bounds the round.
 *
 * One number for a whole fan-out has to be sized for its slowest
 * member, so a roster mixing a small fast model with a large one at
 * high thinking either holds slots the fast reviewers do not need or
 * cuts the slow one off mid-thought. That is the shape of the incident
 * this whole workstream came out of: the rounds that ran past fifteen
 * minutes lost two, three, six and seven reviewers, and the eight
 * minute rounds beside them lost none.
 *
 * Each clock on its own, because the three answer three different
 * questions and a participant with a lot to read needs the wall moved
 * and not the liveness guard.
 */
export function budgetFor(
	participant: Participant,
	round: ReviewerBudget,
): ReviewerBudget {
	return {
		timeoutMs: positiveNumber(participant.backstopMs) ?? round.timeoutMs,
		idleTimeoutMs: positiveNumber(participant.idleMs) ?? round.idleTimeoutMs,
		// Zero is honoured here for the same reason it is honoured in the
		// round's own config: it is the documented way to say do not
		// interrupt me early. Read as a typo, a participant asking not to
		// be interrupted would fall back to the round's reserve and be
		// interrupted anyway, which is the one outcome nobody wrote it
		// for.
		wrapUpReserveMs:
			participant.answerMs === 0
				? 0
				: (positiveNumber(participant.answerMs) ?? round.wrapUpReserveMs),
	};
}

export function reviewerBudget(section: unknown): ReviewerBudget {
	const held = isRecord(section) ? section : {};
	return {
		timeoutMs: positiveNumber(held.backstopMs) ?? REVIEWER_BACKSTOP_MS,
		idleTimeoutMs: positiveNumber(held.idleMs) ?? REVIEWER_IDLE_MS,
		// Zero is honoured rather than rejected, because it is the
		// documented way to turn the soft deadline off. Every other
		// clock here treats zero as a typo, and for them it is: a zero
		// backstop stops every reviewer the instant it starts. A zero
		// reserve just means do not ask early.
		wrapUpReserveMs:
			held.answerMs === 0
				? 0
				: (positiveNumber(held.answerMs) ?? REVIEWER_ANSWER_MS),
	};
}

/** A duration that could actually be used, or nothing. */
function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

/** Whether config handed us something with fields to read. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
