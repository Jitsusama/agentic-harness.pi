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

import type { AskAnswer, AskLimit, AskStop } from "../../lib/review/index.js";
import type {
	ReviewerTerminalState,
	RunReviewerResult,
} from "../../lib/subagent/index.js";
import { DEFAULT_RUN_PI_TIMEOUT_MS } from "../../lib/subagent/runpi/spawn.js";

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
	cancelled: /cancelled/i,
	"parent-exit": /parent process/i,
};

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

/** Read one reviewer's run as an answer, a stop, or a failure. */
export function answerFromReviewer(result: RunReviewerResult): AskAnswer {
	const stopped = stopFrom(result);
	if (stopped !== undefined) {
		return {
			text: result.finalAssistantText,
			stopped,
			...usageOf(result),
		};
	}

	// No limit fired, so an empty non-zero run is a run that never
	// produced anything: the model was unavailable, the install was
	// stale, the process died. That is a failure, and it is the only
	// thing left that still is one.
	if (result.exitCode !== 0 && result.finalAssistantText.trim() === "") {
		return { failure: failureFrom(result) };
	}

	return { text: result.finalAssistantText, ...usageOf(result) };
}

/** The stop this run represents, when a limit ended it. */
function stopFrom(result: RunReviewerResult): AskStop | undefined {
	const limit = result.state === undefined ? undefined : LIMITS[result.state];
	if (limit === undefined) return undefined;
	return { limit, detail: detailFrom(result, limit) };
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
	return said ?? `Stopped at the ${limit} limit.`;
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
