/**
 * Telling a model call that failed for a moment from one that will
 * fail the same way again, and how long to wait before asking again.
 *
 * pi retries a failed call itself a few times within seconds, then
 * ends the turn. A provider that is down or slow for minutes outlasts
 * that, so the harness asks again on a slower schedule. Both use pi's
 * own judgement of what is worth retrying, so a usage limit or a bad
 * request is never asked twice.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

/**
 * Errors pi-ai calls transient, for a pi from before it exported its
 * own classifier: a dropped or reset stream, an overloaded or
 * rate-limited provider, a server error, a timeout.
 */
const TRANSIENT_ERROR =
	/overloaded|rate.?limit|too many requests|\b429\b|\b5\d\d\b|stream ended|message_stop|econnreset|socket hang up|timed? ?out|network|fetch failed/i;

/** The first wait after pi's own retries run out. */
export const FIRST_WAIT_MS = 30_000;

/** The longest wait between two tries. */
export const LONGEST_WAIT_MS = 300_000;

/**
 * How many times the harness asks again before it leaves the turn
 * ended: about 17 minutes of waiting in all.
 */
export const MOST_TRIES = 6;

/** Whether a failed reply is one a second call could get past. */
export function isTransientFailure(reply: AssistantMessage): boolean {
	const classify: unknown = Reflect.get(piAi, "isRetryableAssistantError");
	if (typeof classify === "function") return Boolean(classify(reply));
	return (
		reply.stopReason === "error" &&
		TRANSIENT_ERROR.test(reply.errorMessage ?? "")
	);
}

/**
 * Whether a reply that ended a turn failed for a moment, and so is
 * worth a later try: transient, and not a context too long for the
 * model, which compaction answers rather than a retry.
 */
export function failedForAMoment(
	reply: AssistantMessage,
	contextWindow: number,
): boolean {
	if (!isTransientFailure(reply)) return false;
	const overflow: unknown = Reflect.get(piAi, "isContextOverflow");
	if (typeof overflow === "function" && overflow(reply, contextWindow)) {
		return false;
	}
	return true;
}

/**
 * How long to wait before try `attempt` (1 for the first): doubling
 * from {@link FIRST_WAIT_MS} up to {@link LONGEST_WAIT_MS}, or
 * undefined once {@link MOST_TRIES} are spent.
 */
export function waitBefore(attempt: number): number | undefined {
	if (!Number.isInteger(attempt) || attempt < 1 || attempt > MOST_TRIES) {
		return undefined;
	}
	return Math.min(FIRST_WAIT_MS * 2 ** (attempt - 1), LONGEST_WAIT_MS);
}

/** The last assistant reply among a run's messages, if it has one. */
export function lastReply(
	messages: readonly unknown[],
): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) return message;
	}
	return undefined;
}

/** The first line of a failure's message, short enough for a notice. */
export function failureLine(reply: AssistantMessage): string {
	const first = (reply.errorMessage ?? "the model call failed")
		.split("\n")[0]
		?.trim();
	if (!first) return "the model call failed";
	return first.length > FAILURE_LINE_CHARS
		? `${first.slice(0, FAILURE_LINE_CHARS - 3)}...`
		: first;
}

const FAILURE_LINE_CHARS = 100;

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "role") === "assistant" &&
		typeof Reflect.get(value, "stopReason") === "string"
	);
}
