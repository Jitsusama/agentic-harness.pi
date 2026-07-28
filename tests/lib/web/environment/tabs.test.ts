/**
 * The tabs a session can see, and picking one of them.
 */

import { describe, expect, it } from "vitest";
import {
	chooseTab,
	renderTabs,
	type TabRecord,
} from "../../../../lib/web/environment/tabs.js";

const OPEN: readonly TabRecord[] = [
	{ index: 1, url: "https://shop.example/cart", title: "Cart", current: true },
	{
		index: 2,
		url: "https://pay.example/checkout",
		title: "Pay",
		current: false,
	},
];

describe("renderTabs", () => {
	it("marks which one the session is driving", () => {
		// Every read and every act goes to one tab. Which one that is
		// is the single fact a caller cannot work out for themselves.
		const rendered = renderTabs(OPEN);

		expect(rendered).toContain("Cart");
		expect(rendered).toContain("Pay");
		expect(rendered.split("\n")[1]).toContain("driving");
	});

	it("says a lone tab is the only one, rather than listing it", () => {
		const rendered = renderTabs([OPEN[0] as TabRecord]);

		expect(rendered.toLowerCase()).toContain("one tab");
	});
});

describe("chooseTab", () => {
	it("finds the tab asked for", () => {
		const chosen = chooseTab(OPEN, 2);

		expect("refusal" in chosen).toBe(false);
		if ("refusal" in chosen) return;
		expect(chosen.title).toBe("Pay");
	});

	it("refuses a tab that is not open by naming the ones that are", () => {
		// A bare "no such tab" makes the caller ask a second question
		// to find out what they should have said, and the answer is
		// already in hand.
		const chosen = chooseTab(OPEN, 5);

		expect("refusal" in chosen).toBe(true);
		if (!("refusal" in chosen)) return;
		expect(chosen.refusal).toContain("2");
		expect(chosen.refusal).toContain("Pay");
	});

	it("refuses nothing at all rather than reporting an empty list", () => {
		const chosen = chooseTab([], 1);

		expect("refusal" in chosen).toBe(true);
	});
});
