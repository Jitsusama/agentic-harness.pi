/**
 * The node's watch of messages: each message as the node says it, read
 * back as the mesh's file has it, and the watch's lines heard in turn.
 */
import { describe, expect, it, type Mock, vi } from "vitest";
import type { Message } from "../../../lib/mesh/message.ts";
import {
	type MessageEvents,
	messageOfNode,
	messagesHeard,
} from "../../../lib/mesh/node-messages.ts";

/** A message as mycelium's `Message` says it on a watch. */
const said = (fields: Record<string, unknown> = {}) => ({
	id: "1793046604647-OSPHT4-101-1a2b3c4d",
	at: "2026-11-21T18:00:00.000Z",
	from: "OSPHT4",
	groups: ["peer.wcjqsg", "quest.wcjqsg", "all"],
	intent: "question",
	text: "may I",
	pid: 101,
	...fields,
});

/** Events that keep what a watch says. */
function hearing(): MessageEvents & {
	ready: Mock<() => void>;
	heard: Mock<(message: Message) => void>;
	ended: Mock<() => void>;
} {
	return {
		ready: vi.fn<() => void>(),
		heard: vi.fn<(message: Message) => void>(),
		ended: vi.fn<() => void>(),
	};
}

describe("a message as the node says it", () => {
	it("reads as the mesh's file has it, its groups as targets", () => {
		expect(
			messageOfNode(
				said({
					re: "1793046600000-WCJQSG-7-00000000",
					hosted: true,
					invite: "#harness",
					endsHold: true,
					fromRealm: "work",
				}),
			),
		).toEqual({
			v: 1,
			id: "1793046604647-OSPHT4-101-1a2b3c4d",
			at: "2026-11-21T18:00:00.000Z",
			from: "OSPHT4",
			to: ["@WCJQSG", "#quest/wcjqsg", "#all"],
			intent: "question",
			text: "may I",
			pid: 101,
			hosted: true,
			invite: "#harness",
			re: "1793046600000-WCJQSG-7-00000000",
			endsHold: true,
			fromRealm: "work",
		});
	});

	it("is none without its process, or bound for another realm", () => {
		const { pid: _pid, ...unsent } = said();
		expect(messageOfNode(unsent), "no process").toBeUndefined();
		expect(
			messageOfNode(said({ forRealm: "work" })),
			"another realm's",
		).toBeUndefined();
		expect(messageOfNode({ ...said(), groups: "all" }), "no groups").toBe(
			undefined,
		);
	});
});

describe("the lines a watch of messages says", () => {
	it("is ready at its yes, then hears the latest and each one after", () => {
		const events = hearing();
		const end = vi.fn();
		const hear = messagesHeard(events, end);
		hear(JSON.stringify({ Ok: "Watching" }));
		expect(events.ready, "ready at its yes").toHaveBeenCalledTimes(1);
		hear(JSON.stringify({ SessionsChanged: { sessions: [] } }));
		hear(
			JSON.stringify({
				MessagesChanged: { messages: [said({ id: "1-A-1-a" })] },
			}),
		);
		hear(JSON.stringify({ Message: { message: said({ id: "2-A-1-b" }) } }));
		hear(JSON.stringify({ SessionForgotten: { id: "s" } }));
		hear(JSON.stringify({ SomethingNewer: {} }));
		expect(
			events.heard.mock.calls.map(([message]) => message.id),
			"each message, in turn",
		).toEqual(["1-A-1-a", "2-A-1-b"]);
		expect(end, "sessions and newer events end nothing").not.toHaveBeenCalled();
	});

	it("passes over a message it can't read, and ends at a line it can't", () => {
		const events = hearing();
		const end = vi.fn();
		const hear = messagesHeard(events, end);
		hear(JSON.stringify({ Ok: "Watching" }));
		hear(JSON.stringify({ Message: { message: { id: "torn" } } }));
		expect(events.heard, "the torn one passed over").not.toHaveBeenCalled();
		expect(end, "a torn message ends nothing").not.toHaveBeenCalled();
		hear("not json");
		expect(end, "a line it can't read").toHaveBeenCalledTimes(1);
	});

	it("ends at anything but its yes", () => {
		const events = hearing();
		const end = vi.fn();
		messagesHeard(events, end)(JSON.stringify({ Err: "no such request" }));
		expect(end, "a refusal").toHaveBeenCalledTimes(1);
		expect(events.ready, "never ready").not.toHaveBeenCalled();
	});
});
