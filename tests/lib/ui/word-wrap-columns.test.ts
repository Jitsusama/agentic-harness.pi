/**
 * V10 of the validation plan: wrapping has to count what the terminal draws.
 *
 * A gate row is wrapped to the panel width and then padded to it, and the
 * panel truncates whatever still overruns. So a wrap that measures the wrong
 * quantity does not wrap wrongly in a visible way, it silently loses the end
 * of the line.
 *
 * The quantity is columns, and JavaScript string length is not it. An emoji
 * is two UTF-16 units and two columns, so the two agree by luck and the
 * section headings this package puts in every PR body are fine. A CJK
 * character is one unit and two columns, and there they disagree: a body
 * carrying any is wrapped to twice the width it should be. That is not
 * hypothetical here, since a stray CJK character reached a commit subject in
 * the session that prompted this plan.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { wordWrap } from "../../../lib/ui/text-layout.js";

const WIDTH = 20;

/** The widest row, in the columns a terminal would give it. */
function widest(lines: string[]): number {
	return Math.max(...lines.map((line) => visibleWidth(line)));
}

describe("wrapping counts columns", () => {
	it("keeps plain text inside the width, as it always did", () => {
		const wrapped = wordWrap(
			"the quick brown fox jumps over the lazy dog and keeps running",
			WIDTH,
		);

		expect(widest(wrapped)).toBeLessThanOrEqual(WIDTH);
	});

	it("keeps double-width characters inside the width", () => {
		// Sixteen characters, thirty-two columns. Measured by length it fits a
		// twenty-column panel; measured by columns it plainly does not.
		const wrapped = wordWrap("次の行は折り返される必要がある文字", WIDTH);

		expect(widest(wrapped)).toBeLessThanOrEqual(WIDTH);
	});

	it("keeps a mixed line inside the width", () => {
		const wrapped = wordWrap("a heading 名前 and more words after it", WIDTH);

		expect(widest(wrapped)).toBeLessThanOrEqual(WIDTH);
	});

	it("keeps the emoji headings this package writes inside the width", () => {
		const wrapped = wordWrap("### 🌐 Situation and then some more text", WIDTH);

		expect(widest(wrapped)).toBeLessThanOrEqual(WIDTH);
	});

	it("loses nothing while wrapping", () => {
		// Wrapping may add breaks; it may not drop characters. Spaces at the
		// break are consumed, so compare with whitespace removed.
		const text = "the quick brown fox 名前 jumps over the lazy dog";
		const wrapped = wordWrap(text, WIDTH).join(" ");

		expect(wrapped.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
	});

	it("still breaks a word too long to fit rather than looping", () => {
		const wrapped = wordWrap("x".repeat(55), WIDTH);

		expect(wrapped.length).toBeGreaterThan(1);
		expect(widest(wrapped)).toBeLessThanOrEqual(WIDTH);
	});
});
