import { describe, expect, it } from "vitest";
import {
	MAX_OUTLINE_BUDGET_BYTES,
	OUTLINE_BUDGET_BYTES,
	outlineBudget,
} from "../../../../lib/web/a11y/budget.js";

describe("how much outline a caller can ask for", () => {
	it("gives the generous default when nothing is asked for", () => {
		expect(outlineBudget(undefined)).toBe(OUTLINE_BUDGET_BYTES);
	});

	it("honours a smaller request", () => {
		expect(outlineBudget(2_048)).toBe(2_048);
	});

	it("will not paste a whole megabyte because it was asked to", () => {
		// The point of a budget is what reaches a context window, and
		// the model choosing the number is the party with no idea what
		// it costs. Raising it buys nothing either: whatever is cut is
		// stored and queryable whatever the budget was, so a huge one
		// spends context to reach data that was already reachable.
		expect(outlineBudget(100_000_000)).toBe(MAX_OUTLINE_BUDGET_BYTES);
	});

	it("never returns a budget of nothing", () => {
		// Zero would cut the whole view and leave a citation with no
		// view above it, which reads as though the page were empty.
		expect(outlineBudget(0)).toBe(1);
		expect(outlineBudget(-5)).toBe(1);
	});
});
