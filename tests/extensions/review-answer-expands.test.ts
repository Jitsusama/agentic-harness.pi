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
 *
 * The shape follows the rest of the package rather than inventing one.
 * A collapsed result elsewhere is a digest and not an excerpt: Google
 * opens with a mark and a count and then previews a few, and the browser
 * opens with the verdict word. A shared renderer only has prose to work
 * with, so the digest comes from the tool that knows what it did, and a
 * tool that offers none falls back to the head of its own answer.
 */

import { describe, expect, it } from "vitest";
import type { Answer } from "../../extensions/review-integration/tools/shared.js";
import { renderAnswer } from "../../extensions/review-integration/tools/shared.js";
import { fakeTheme } from "../lib/ui/fake-theme.js";

/** `count` numbered lines. */
function answerText(count: number): string {
	return Array.from({ length: count }, (_, at) => `line ${at + 1}`).join("\n");
}

/** An answer carrying `count` numbered lines and no digest. */
function answerOf(count: number): Answer {
	return {
		content: [{ type: "text", text: answerText(count) }],
		details: undefined,
	} as Answer;
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

	it("leads with the tool's own digest when it offers one", () => {
		const answer = {
			content: [{ type: "text", text: "line 1\nline 2\nline 3" }],
			details: { ok: true, summary: "34 files" },
		} as unknown as Answer;
		expect(drawn(answer).split("\n")[0]).toContain("34 files");
	});

	it("previews under the digest, the way the other tools do", () => {
		const answer = {
			content: [{ type: "text", text: answerText(40) }],
			details: { ok: true, summary: "40 threads" },
		} as unknown as Answer;
		const shown = drawn(answer);
		expect(shown).toContain("40 threads");
		expect(shown).toContain("line 1");
		expect(shown).toMatch(/\.\.\. \d+ more/);
		expect(shown).not.toContain("line 40");
	});

	it("gives the whole answer when expanded, digest and all", () => {
		const answer = {
			content: [{ type: "text", text: answerText(40) }],
			details: { ok: true, summary: "40 threads" },
		} as unknown as Answer;
		const shown = drawn(answer, true);
		expect(shown).toContain("line 40");
		expect(shown).not.toContain("more");
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
