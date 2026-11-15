/**
 * Reading a send-back away mode held back for a move, and whether a move
 * waits or has been made, with presence and the move note stood in for.
 */

import { describe, expect, it } from "vitest";
import {
	HELD_BACK_ENTRY,
	heldBackIn,
	movedOn,
	moveWaits,
} from "../../../extensions/away-workflow/held-back.ts";

const held = (text: string) => ({
	type: "custom",
	customType: HELD_BACK_ENTRY,
	data: { text },
});

describe("a send-back held back in a log", () => {
	it("is read when it is the log's last word", () => {
		const branch = [
			{ type: "message", message: { role: "assistant" } },
			held("keep working"),
		];

		expect(heldBackIn(branch)).toBe("keep working");
	});

	it("is read past entries that say nothing in the conversation", () => {
		const branch = [
			held("keep working"),
			{ type: "custom", customType: "jobs-carried", data: {} },
		];

		expect(heldBackIn(branch)).toBe("keep working");
	});

	it("is spent once a message follows it", () => {
		const branch = [
			held("keep working"),
			{ type: "message", message: { role: "user" } },
		];

		expect(heldBackIn(branch)).toBeUndefined();
	});

	it("is spent once a delivered note follows it", () => {
		const branch = [
			held("keep working"),
			{ type: "custom_message", customType: "away-sent-on" },
		];

		expect(heldBackIn(branch)).toBeUndefined();
	});

	it("is nothing in a log that never held one", () => {
		expect(
			heldBackIn([{ type: "message", message: { role: "assistant" } }]),
		).toBeUndefined();
	});

	it("is nothing when its entry is malformed", () => {
		expect(
			heldBackIn([{ type: "custom", customType: HELD_BACK_ENTRY, data: {} }]),
		).toBeUndefined();
	});
});

describe("a move", () => {
	it("waits while the session's presence says one does", () => {
		expect(
			moveWaits("s1", () => ({ to: "pi", since: "now" })),
			"a move in its presence waits",
		).toBe(true);
		expect(
			moveWaits("s1", () => undefined),
			"none in it waits",
		).toBe(false);
	});

	it("has been made once its note is written", () => {
		expect(
			movedOn("s1", () => ({ to: "pi" })),
			"a note written",
		).toBe(true);
		expect(
			movedOn("s1", () => undefined),
			"no note",
		).toBe(false);
	});
});
