/**
 * Websocket traffic, folded into conversations and read back.
 */

import { describe, expect, it } from "vitest";
import {
	foldSockets,
	renderSockets,
	type SocketEvent,
} from "../../../../lib/web/telemetry/sockets.js";

const OPENED: SocketEvent = {
	kind: "opened",
	id: "s1",
	at: 1000,
	url: "wss://live.example/feed",
};

const events = (...more: SocketEvent[]): SocketEvent[] => [OPENED, ...more];

describe("foldSockets", () => {
	it("gathers frames under the socket they belong to", () => {
		const folded = foldSockets(
			events(
				{ kind: "sent", id: "s1", at: 1010, payload: "subscribe" },
				{ kind: "received", id: "s1", at: 1020, payload: "ok" },
			),
		);

		expect(folded).toHaveLength(1);
		expect(folded[0]?.url).toBe("wss://live.example/feed");
		expect(folded[0]?.frames.map((frame) => frame.direction)).toEqual([
			"sent",
			"received",
		]);
	});

	it("keeps two sockets apart", () => {
		const folded = foldSockets(
			events(
				{ kind: "opened", id: "s2", at: 1005, url: "wss://other.example/x" },
				{ kind: "sent", id: "s2", at: 1015, payload: "hi" },
			),
		);

		expect(folded).toHaveLength(2);
		expect(folded[1]?.frames).toHaveLength(1);
	});

	it("records that a socket closed, and when", () => {
		const folded = foldSockets(events({ kind: "closed", id: "s1", at: 2000 }));

		expect(folded[0]?.closedAt).toBe(2000);
	});

	it("leaves an open socket open rather than guessing a close", () => {
		const folded = foldSockets(events());

		expect(folded[0]?.closedAt).toBeUndefined();
	});

	it("keeps a frame whose socket was never announced", () => {
		// The recorder can attach mid-conversation, and a frame with
		// no opening is still evidence. Dropping it would report a
		// silent socket as no socket.
		const folded = foldSockets([
			{ kind: "received", id: "ghost", at: 1, payload: "late" },
		]);

		expect(folded).toHaveLength(1);
		expect(folded[0]?.frames).toHaveLength(1);
	});

	it("records a socket that failed, with why", () => {
		const folded = foldSockets(
			events({ kind: "failed", id: "s1", at: 1100, error: "handshake" }),
		);

		expect(folded[0]?.error).toBe("handshake");
	});
});

describe("renderSockets", () => {
	it("says nothing happened when nothing did, without implying it looked away", () => {
		expect(renderSockets([])).toContain("No websocket");
	});

	it("shows the conversation in order with direction", () => {
		const rendered = renderSockets(
			foldSockets(
				events(
					{ kind: "sent", id: "s1", at: 1010, payload: "subscribe" },
					{ kind: "received", id: "s1", at: 1020, payload: "ok" },
				),
			),
		);

		expect(rendered).toContain("live.example");
		expect(rendered.indexOf("subscribe")).toBeLessThan(rendered.indexOf("ok"));
	});

	it("marks a socket still open, which is the normal state", () => {
		const rendered = renderSockets(foldSockets(events()));

		expect(rendered.toLowerCase()).toContain("open");
	});
});
