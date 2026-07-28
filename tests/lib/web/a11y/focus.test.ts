/**
 * What holds focus right now.
 *
 * A question asked constantly while driving a keyboard and, until
 * now, only answerable by evaluating script in the page.
 */

import { describe, expect, it } from "vitest";
import {
	type FocusHolder,
	renderFocus,
} from "../../../../lib/web/a11y/focus.js";

const holder = (over: Partial<FocusHolder> = {}): FocusHolder => ({
	tag: "button",
	onBody: false,
	...over,
});

describe("renderFocus", () => {
	it("names the holder the way the outline names it", () => {
		const said = renderFocus(
			holder({ role: "button", name: "Save changes", tag: "button" }),
		);

		expect(said).toContain('button "Save changes"');
	});

	it("falls back to the tag when nothing gave it a name", () => {
		// A nameless control is worth reporting as itself rather than
		// as nothing, since being unnamed is the more useful finding.
		const said = renderFocus(holder({ tag: "div", role: "button" }));

		expect(said).toContain("button");
		expect(said).toMatch(/div/);
	});

	it("says nothing holds focus when it sits on the body", () => {
		// The browser parks focus on the body when nothing is focused,
		// so reporting "body" as the holder would read as a real
		// control and hide the fact that a tab went nowhere.
		const said = renderFocus(holder({ tag: "body", onBody: true }));

		expect(said).toMatch(/nothing/i);
		expect(said).not.toMatch(/"body"/);
	});

	it("says where it sits when the browser gave it a box", () => {
		const said = renderFocus(
			holder({ rect: { x: 10.4, y: 20.6, width: 100, height: 30 } }),
		);

		expect(said).toContain("10,21 100x30");
	});

	it("reports focus inside a shadow root as such", () => {
		// Focus in a shadow root reads as the host from the outside,
		// which has sent people looking for the wrong element.
		expect(renderFocus(holder({ inShadow: true }))).toMatch(/shadow/i);
	});

	it("declines rather than inventing an answer when it could not look", () => {
		expect(renderFocus(undefined)).toMatch(/could not/i);
	});
});
