/**
 * A long answer should not cost the whole transcript.
 *
 * Every review tool answers through one renderer, and it painted the
 * whole thing every time. That is right for a write, which says one line
 * about what it did, and wrong for a read: a diff or a threads listing
 * runs to hundreds of lines and pushes everything said before it off the
 * screen, whether or not anybody wanted to read it.
 *
 * So the collapsed form keeps the head of the answer and says how much
 * it is holding back, and Ctrl-O gives the rest. Short answers are left
 * exactly as they were, because a hint under a one-line result is noise
 * about nothing.
 */

import { describe, expect, it } from "vitest";
import type { Answer } from "../../extensions/review-integration/tools/shared.js";
import { renderAnswer } from "../../extensions/review-integration/tools/shared.js";
import { fakeTheme } from "../lib/ui/fake-theme.js";

/** An answer carrying `count` numbered lines. */
function answerOf(count: number): Answer {
	const text = Array.from({ length: count }, (_, at) => `line ${at + 1}`).join(
		"\n",
	);
	return { content: [{ type: "text", text }], details: undefined } as Answer;
}

/** What the renderer puts on screen, read the way the terminal reads it. */
function drawn(result: Answer, expanded?: boolean): string {
	return renderAnswer(result, fakeTheme(), { expanded }).render(120).join("\n");
}

describe("an answer that does not fit", () => {
	it("keeps a short answer whole, with nothing added", () => {
		const shown = drawn(answerOf(3));
		expect(shown).toContain("line 1");
		expect(shown).toContain("line 3");
		expect(shown).not.toContain("more");
	});

	it("holds back the tail of a long one", () => {
		const shown = drawn(answerOf(40));
		expect(shown).toContain("line 1");
		expect(shown).not.toContain("line 40");
	});

	it("says how much it is holding back, in the package's own words", () => {
		const shown = drawn(answerOf(40));
		expect(shown).toMatch(/\.\.\. \d+ more/);
	});

	it("gives the whole thing when expanded", () => {
		const shown = drawn(answerOf(40), true);
		expect(shown).toContain("line 1");
		expect(shown).toContain("line 40");
		expect(shown).not.toContain("more");
	});

	it("counts the lines it withheld, not the lines it showed", () => {
		const shown = drawn(answerOf(40));
		const shownLines = (shown.match(/line \d+/g) ?? []).length;
		const withheld = Number(/\.\.\. (\d+) more/.exec(shown)?.[1]);
		expect(shownLines + withheld).toBe(40);
	});

	it("still marks a refusal as one when it is collapsed", () => {
		// A refusal is the answer most worth reading, so losing its colour
		// to the collapsing would be the wrong trade.
		const refusal = {
			content: [{ type: "text", text: "no\n".repeat(40) }],
			details: { error: "that thread is not resolved" },
		} as unknown as Answer;
		expect(drawn(refusal)).toContain("<error>");
	});
});
