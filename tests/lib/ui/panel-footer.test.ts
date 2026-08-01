/**
 * A panel that scrolls has to say so.
 *
 * Both prompts have always scrolled, vertically and horizontally, with a
 * scrollbar in the right-hand gutter and an offset kept per tab and per
 * view. The footer took `needsVScroll` and `needsHScroll` from both of
 * them and rendered neither, so the fields were dead and the panels never
 * mentioned the one thing a person needs to know when text runs off the
 * bottom: that there is more of it, rather than that it was cut off.
 *
 * The hints belong with the other navigation, and they appear only when
 * there is somewhere to go. A hint that is always on is chrome, and chrome
 * is what people stop reading.
 */

import { describe, expect, it } from "vitest";
import { renderFooter } from "../../../lib/ui/panel-layout.js";
import { fakeTheme } from "./fake-theme.js";

/**
 * The footer as one plain string, with the theme's markers taken out.
 *
 * Wide on purpose. The fake theme wraps every styled run in `<dim>` tags,
 * which the layout's width arithmetic counts as visible, so a realistic
 * width here truncates the right-hand side and the test ends up measuring
 * the test double rather than the footer.
 */
function footer(opts: Partial<Parameters<typeof renderFooter>[0]>): string {
	return renderFooter({ theme: fakeTheme(), width: 400, ...opts })
		.join("\n")
		.replaceAll(/<\/?[\w:]+>/g, "");
}

describe("saying that a panel scrolls", () => {
	it("says nothing when everything fits", () => {
		const text = footer({});
		expect(text).not.toContain("scroll");
		expect(text).not.toContain("pan");
	});

	it("offers vertical scrolling when the content runs past the bottom", () => {
		expect(footer({ needsVScroll: true })).toContain("scroll");
	});

	it("offers panning when the content runs past the right edge", () => {
		expect(footer({ needsHScroll: true })).toContain("pan");
	});

	it("offers both when both are true", () => {
		const text = footer({ needsVScroll: true, needsHScroll: true });
		expect(text).toContain("scroll");
		expect(text).toContain("pan");
	});

	it("names the keys that actually do it", () => {
		// Shift with the arrows, which is what scroll-region binds. A hint
		// naming a key that does nothing is worse than no hint.
		const text = footer({ needsVScroll: true, needsHScroll: true });
		expect(text).toContain("\u21e7+\u2191\u2193");
		expect(text).toContain("\u21e7+\u2190\u2192");
	});

	it("keeps the hints with the rest of the navigation, left of centre", () => {
		const text = footer({ needsVScroll: true, hasTabs: true });
		expect(text.indexOf("scroll")).toBeLessThan(text.indexOf("Esc cancel"));
	});

	it("still says what Enter does when it is scrolling as well", () => {
		expect(footer({ needsVScroll: true, enterHint: "approve" })).toContain(
			"Enter approve",
		);
	});
});
