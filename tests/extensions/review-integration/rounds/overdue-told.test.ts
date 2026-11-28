/**
 * A round overdue in the start line, told to the session that asked.
 *
 * Nothing a round waiting for its start says reached its asker: on 27
 * November 14 rounds never started and no session waiting on one was
 * told (1JQPPC). An overdue round says so on the bus, and the load
 * listening tells its session with a message of its own, waking it
 * when idle.
 */

import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	sayOverdue,
	tellOverdue,
} from "../../../../extensions/review-integration/overdue.ts";

/** What one call to `sendMessage` was given. */
interface Sent {
	readonly message: unknown;
	readonly options: unknown;
}

/**
 * A bus that calls its handlers as it is said to, so a handler's throw
 * reaches whoever said it; pi's own logs and swallows it, which would
 * hide a hearer that throws.
 */
function directBus(): EventBus {
	const handlers: ((data: unknown) => void)[] = [];
	return {
		emit: (_channel, data) => {
			for (const handler of handlers) handler(data);
		},
		on: (_channel, handler) => {
			handlers.push(handler);
			return () => {};
		},
	};
}

describe("a round overdue in the start line", () => {
	it("is told to its session after the run under way, or as a turn of its own", () => {
		const events = createEventBus();
		const sent: Sent[] = [];
		tellOverdue({
			events,
			sendMessage: (message, options) => {
				sent.push({ message, options });
			},
		});

		sayOverdue(events, "The council round on o/r#1 was due to start by …");

		expect(sent).toEqual([
			{
				message: {
					customType: "review-round-overdue",
					content: "The council round on o/r#1 was due to start by …",
					display: true,
				},
				options: { deliverAs: "followUp", triggerTurn: true },
			},
		]);
	});

	it("costs the round nothing when its load was replaced as it heard", () => {
		const events = directBus();
		tellOverdue({
			events,
			sendMessage: () => {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			},
		});

		expect(() => sayOverdue(events, "overdue")).not.toThrow();
	});
});
