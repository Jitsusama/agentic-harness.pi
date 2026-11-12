/**
 * The footer's marks each take one cell, since the line counts every
 * status's columns and a mark drawn double would push the line past its
 * width or leave a gap beside it.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	FOOTER_GLYPH,
	footerMark,
	footerShare,
} from "../../../lib/ui/footer-mark.ts";

const plain = { fg: (_colour: string, text: string) => text };

describe("the footer's marks", () => {
	it.each(Object.entries(FOOTER_GLYPH))("%s takes one cell", (_name, glyph) => {
		expect(visibleWidth(glyph)).toBe(1);
	});

	it("counts only past one", () => {
		expect(footerMark("budget", "dim", plain)).toBe(FOOTER_GLYPH.budget);
		expect(footerMark("failed", "error", plain, 1)).toBe(FOOTER_GLYPH.failed);
		expect(footerMark("failed", "error", plain, 3)).toBe(
			`${FOOTER_GLYPH.failed} 3`,
		);
	});

	it("shows a share only when given one, and never past all of it", () => {
		expect(footerShare("budget", "dim", plain)).toBe(FOOTER_GLYPH.budget);
		expect(footerShare("budget", "warning", plain, 84)).toBe(
			`${FOOTER_GLYPH.budget} 84%`,
		);
		expect(footerShare("budget", "error", plain, 312)).toBe(
			`${FOOTER_GLYPH.budget} 100%`,
		);
	});
});
