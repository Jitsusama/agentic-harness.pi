/**
 * A round waiting in the machine's start line past the start it was
 * due at, told to the session that asked (1JQPPC, 27 November: 14
 * rounds that week never started, and nobody waiting was told).
 *
 * None of a round's own ways of saying things reach its asker by then.
 * Its call's `onUpdate` drew only the tool's row, and nothing reads it
 * once the call moves to a job at the minute. Its board shows only
 * once reviewers start, and only to the person. Its job says one thing,
 * its end. So it is told as mesh-workflow tells a session that a hold
 * it waits on settled: a message of its own, after the run under way,
 * or a turn of its own while the session is idle, since an idle waiter
 * is the one nothing else wakes.
 *
 * The round's call may be hours older than the load that tells it, as
 * a reload or an install's move replaces the load and makes the call's
 * own `pi` stale. So the round says it on the conversation's live bus
 * (engine.ts, `liveBus`), and the newest load, the only one pi keeps
 * listening, tells it through its own `pi`.
 */

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The channel a waiting round says it is overdue on. */
const ROUND_OVERDUE = "review:round-overdue:v1";

/** The message an overdue round is told to its session as. */
const OVERDUE_MESSAGE = "review-round-overdue";

/** Says on `bus` that a round waiting for its start is overdue, in `said`. */
export function sayOverdue(bus: Pick<EventBus, "emit">, said: string): void {
	bus.emit(ROUND_OVERDUE, said);
}

/**
 * Tells this load's session of each overdue round said on its bus,
 * shown to the person too, since a round held for an hour is theirs to
 * know of as much as the model's.
 */
export function tellOverdue(
	pi: Pick<ExtensionAPI, "events" | "sendMessage">,
): void {
	pi.events.on(ROUND_OVERDUE, (said: unknown) => {
		if (typeof said !== "string") return;
		try {
			pi.sendMessage(
				{ customType: OVERDUE_MESSAGE, content: said, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// This load was replaced as it heard; the round waits on, and its
			// next lapse is told by the load that replaced this one.
		}
	});
}
