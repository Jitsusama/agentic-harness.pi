/** Co-hosted peers own messages by address, never by their shared pid. */
import { describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import {
	type Message,
	messageFrom,
	reaches,
} from "../../../lib/mesh/message.ts";
import { mayReplace, sentBy } from "../../../lib/mesh/thread.ts";

function message(over: Partial<Message> = {}): Message {
	return {
		v: 1,
		id: "1",
		at: "2026-11-09T14:00:00.000Z",
		from: "ALPHA",
		to: [ALL],
		intent: "question",
		text: "Ready?",
		pid: 7,
		hosted: true,
		...over,
	};
}

describe("co-hosted message ownership", () => {
	it("delivers a sibling's message but not one's own", () => {
		const listener = { addresses: ["BRAVO"], groups: [ALL], hosted: true };
		expect(
			reaches(message(), listener, 7),
			"a sibling's message reaches BRAVO in the same host",
		).toBe(true);
		expect(
			reaches(message({ from: "BRAVO" }), listener, 7),
			"BRAVO's own message does not come back to it",
		).toBe(false);
		expect(
			sentBy(message(), { addresses: ["BRAVO"], pid: 7, hosted: true }),
			"a sibling's message is not counted as BRAVO's own",
		).toBe(false);
	});

	it("does not let a sibling replace another's words", () => {
		expect(
			mayReplace(message({ id: "2", from: "BRAVO" }), message()),
			"BRAVO may not replace a sibling's message",
		).toBe(false);
		expect(
			mayReplace(message({ id: "2" }), message()),
			"a sender may replace its own message",
		).toBe(true);
	});

	it("keeps the hosted stamp when reading an envelope", () => {
		expect(
			messageFrom(message())?.hosted,
			"reading an envelope keeps its hosted stamp",
		).toBe(true);
	});
});
