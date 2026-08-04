/**
 * A rendered row is passive text, never a cursor program.
 *
 * Pi's TUI measures every row with visibleWidth, which strips escape
 * codes, and the overlay compositor pads what it measures out to the
 * terminal width. A row that repositions the cursor (CSI G, or any
 * other movement) lies to that arithmetic: the compositor's padding
 * lands after the jump, the terminal wraps at the last column, and
 * every row below drifts down one line. On screen that read as the
 * gate double-spaced with the transcript bleeding through the gaps,
 * and only when the body was long enough to scroll, because the
 * scrollbar was the one place a row jumped the cursor.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderScrollRegion } from "../../../lib/ui/scroll-region.js";
import { plainTheme } from "./fake-theme.js";

const WIDTH = 80;
const BUDGET = 10;

/** Any CSI sequence that moves the cursor rather than styling text. */
const CURSOR_MOVEMENT = new RegExp(`${"\x1b"}\\[[0-9;]*[A-HJKSTfd]`);

/** A body long enough that the region scrolls and draws its scrollbar. */
function longBody(): string[] {
	return Array.from({ length: 50 }, (_, at) => `line ${at + 1}`);
}

describe("a scrolled row", () => {
	it("contains no cursor movement", () => {
		const { lines } = renderScrollRegion(
			longBody(),
			{ vOffset: 0, hOffset: 0 },
			BUDGET,
			WIDTH,
			plainTheme(),
		);

		for (const line of lines) {
			expect(line).not.toMatch(CURSOR_MOVEMENT);
		}
	});

	it("is exactly the panel width, scrollbar included", () => {
		// The scrollbar sits in the last column. If the row's measured
		// width is what the terminal will actually paint, the compositor
		// adds nothing after it and nothing can wrap.
		const { lines } = renderScrollRegion(
			longBody(),
			{ vOffset: 0, hOffset: 0 },
			BUDGET,
			WIDTH,
			plainTheme(),
		);

		for (const line of lines) {
			expect(visibleWidth(line)).toBe(WIDTH);
		}
	});

	it("keeps the scrollbar in the last column", () => {
		const { lines } = renderScrollRegion(
			longBody(),
			{ vOffset: 0, hOffset: 0 },
			BUDGET,
			WIDTH,
			plainTheme(),
		);

		for (const line of lines) {
			expect(line.endsWith("█") || line.endsWith("░")).toBe(true);
		}
	});
});
