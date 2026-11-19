/**
 * The retry's own record in the session, so a wait that a reload or a
 * host restart cuts short is taken up by the load that follows.
 *
 * A wait lives in a timer, and a timer dies with its load. On 18
 * November a reload between runs came seconds after the last relay
 * 502 in three sessions, which then sat idle for hours, and a host
 * restart took a pending try from two more. Each wait now leaves a
 * mark in the session's branch, and a fresh load reads the branch's
 * end to see whether a turn was left on a passing failure.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	failedForAMoment,
	lastReply,
	waitBefore,
} from "../../lib/internal/errors/model-failure.ts";

/** The custom entry type a wait's mark is kept under. */
export const RETRY_ENTRY = "model-retry";

/**
 * A wait's mark: try `attempt` was due at `due`. An attempt of 0 says
 * the person stopped the count, by typing or with Escape.
 */
export interface RetryMark {
	readonly attempt: number;
	readonly due?: number;
}

/** A wait a fresh load takes up: try `attempt`, due at `due`. */
export interface UnfinishedWait {
	readonly attempt: number;
	readonly due: number;
	readonly reply: AssistantMessage;
}

/**
 * How long a turn left on a failure is still taken up. An old session
 * opened again, whose last call failed yesterday, is not set trying on
 * its own; its person types to carry on.
 */
export const TAKEN_UP_WITHIN_MS = 3_600_000;

/**
 * The wait the branch was left in, when its last message is a reply
 * that failed for a moment, no older than {@link TAKEN_UP_WITHIN_MS}:
 * the pending try a mark after that reply names, or else the try after
 * the streak's last mark, or else the first.
 */
export function unfinishedWait(
	branch: readonly unknown[],
	contextWindow: number,
	now: number,
): UnfinishedWait | undefined {
	const last = lastMessageAt(branch);
	if (last === undefined) return undefined;
	const reply = lastReply([messageOf(branch[last])]);
	if (!reply || !failedForAMoment(reply, contextWindow)) return undefined;
	const failedAt = reply.timestamp || now;
	const mark = streakMark(branch);
	const wait = waitFrom(mark, last, failedAt);
	if (!wait) return undefined;
	// A wait last heard of an hour ago: the pending try's due time, or
	// the failure itself when no try was set.
	if (now - wait.since > TAKEN_UP_WITHIN_MS) return undefined;
	return { attempt: wait.attempt, due: wait.due, reply };
}

/**
 * The try a mark leads to, given where the last message sits, and
 * when the wait was last heard of.
 */
function waitFrom(
	mark: { at: number; mark: RetryMark } | undefined,
	last: number,
	failedAt: number,
): { attempt: number; due: number; since: number } | undefined {
	const after = mark !== undefined && mark.at > last;
	if (after && mark.mark.attempt === 0) return undefined;
	if (after) {
		const due = mark.mark.due ?? failedAt;
		return { attempt: mark.mark.attempt, due, since: due };
	}
	const attempt = (mark?.mark.attempt ?? 0) + 1;
	const due = failedAt + (waitBefore(attempt) ?? 0);
	return { attempt, due, since: failedAt };
}

/**
 * The latest mark of the streak the branch ends in, walking back until
 * a reply that did not fail, which ends a streak.
 */
function streakMark(
	branch: readonly unknown[],
): { at: number; mark: RetryMark } | undefined {
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		const mark = markOf(entry);
		if (mark) return { at, mark };
		const message = messageOf(entry);
		if (
			field(message, "role") === "assistant" &&
			field(message, "stopReason") !== "error"
		) {
			return undefined;
		}
	}
	return undefined;
}

function lastMessageAt(branch: readonly unknown[]): number | undefined {
	for (let at = branch.length - 1; at >= 0; at--) {
		if (messageOf(branch[at]) !== undefined) return at;
	}
	return undefined;
}

/** A branch entry's message, when it is a message entry. */
function messageOf(entry: unknown): unknown {
	if (field(entry, "type") !== "message") return undefined;
	return field(entry, "message");
}

/** A branch entry's retry mark, when it is one. */
function markOf(entry: unknown): RetryMark | undefined {
	if (field(entry, "type") !== "custom") return undefined;
	if (field(entry, "customType") !== RETRY_ENTRY) return undefined;
	const data = field(entry, "data");
	const attempt = field(data, "attempt");
	const due = field(data, "due");
	if (typeof attempt !== "number" || !Number.isInteger(attempt)) {
		return undefined;
	}
	return typeof due === "number" ? { attempt, due } : { attempt };
}

/** A field of a value read from the session's log, which may be anything. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? Reflect.get(value, key)
		: undefined;
}
