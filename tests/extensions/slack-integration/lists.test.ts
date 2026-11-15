import { describe, expect, it } from "vitest";
import { drawn } from "./drawn.ts";

/**
 * How the Slack tool draws a list it found: a count, then a few previews
 * while folded, or the whole answer once opened.
 */

const MESSAGES = [
	{ text: "hello", conversation: { displayName: "#general" } },
	{ text: "bye" },
];
const ANSWER = "the whole answer";

/** The lines drawn, without the padding the component adds. */
const lines = (shown: string) =>
	shown.split("\n").map((line) => line.trimEnd());

describe("how a Slack list is drawn", () => {
	it("previews found messages while folded, and shows the answer opened", () => {
		const details = { total: 2, messages: MESSAGES };

		expect(lines(drawn(ANSWER, details))).toEqual([
			"<success>✓ 2 messages",
			"  <dim>?<muted> (#general): hello",
			"  <dim>?: bye",
		]);
		expect(lines(drawn(ANSWER, details, true))).toEqual([
			"<success>✓ 2 messages",
			ANSWER,
		]);
	});

	it("previews found files by name while folded", () => {
		const details = { total: 3, files: [{ name: "a.png" }, {}] };

		expect(lines(drawn(ANSWER, details))).toEqual([
			"<success>✓ 3 files",
			"  <dim>a.png",
			"  <dim>untitled",
		]);
		expect(lines(drawn(ANSWER, details, true))).toEqual([
			"<success>✓ 3 files",
			ANSWER,
		]);
	});

	it("counts a thread's messages and previews them the same way", () => {
		const details = { messages: MESSAGES.slice(1) };

		expect(lines(drawn(ANSWER, details))).toEqual([
			"<success>✓ 1 message",
			"  <dim>?: bye",
		]);
		expect(lines(drawn(ANSWER, details, true))).toEqual([
			"<success>✓ 1 message",
			ANSWER,
		]);
	});
});
