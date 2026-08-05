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

import type { AskLimit, AskStop } from "../../lib/review/index.js";
import { DEFAULT_RUN_PI_TIMEOUT_MS } from "../../lib/subagent/runpi/spawn.js";

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

/** What bounds one reviewer's run. */
export interface ReviewerBudget {
	timeoutMs: number;
	idleTimeoutMs: number;
}

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
	Record<AskLimit, { of: keyof ReviewerBudget; named: string }>
> = {
	"wall-clock": { of: "timeoutMs", named: "backstopMs" },
	idle: { of: "idleTimeoutMs", named: "idleMs" },
};

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
	budget: ReviewerBudget,
): string | undefined {
	if (stopped?.budgetMs === undefined) return undefined;
	const measure = MEASURED_BY[stopped.limit];
	if (measure === undefined) return undefined;
	const now = budget[measure.of];
	if (now > stopped.budgetMs) return undefined;
	return (
		`This reviewer was not failing, it was stopped: it hit the ${stopped.limit} ` +
		`limit of ${stopped.budgetMs}ms and the limit is still ${now}ms, so asking ` +
		`again buys the same wall at the same price. Raise review.ask.${measure.named} ` +
		"past what it needed and ask again, or take what it did send: a stopped " +
		"reviewer's answer is kept, and the findings it finished are already read."
	);
}

export function reviewerBudget(section: unknown): ReviewerBudget {
	const held = isRecord(section) ? section : {};
	return {
		timeoutMs: positiveNumber(held.backstopMs) ?? REVIEWER_BACKSTOP_MS,
		idleTimeoutMs: positiveNumber(held.idleMs) ?? REVIEWER_IDLE_MS,
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
