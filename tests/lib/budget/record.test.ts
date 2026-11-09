import { describe, expect, it } from "vitest";
import { budgetDrawnOn, lastRecorded } from "../../../lib/budget/record.ts";

const said = (data: unknown) => ({
	type: "custom",
	customType: "budget",
	data,
});

describe("the budget a process draws on", () => {
	it("is the name in PI_BUDGET, or the default without one", () => {
		expect(budgetDrawnOn({ PI_BUDGET: "delta" })).toBe("delta");
		expect(budgetDrawnOn({})).toBeNull();
		expect(budgetDrawnOn({ PI_BUDGET: "  " })).toBeNull();
	});

	it("is the default when PI_BUDGET holds a word that can't be a name", () => {
		expect(budgetDrawnOn({ PI_BUDGET: "../keys" })).toBeNull();
	});
});

describe("the budget a branch last recorded", () => {
	it("is the newest budget entry's, the default included", () => {
		const branch = [
			said({ v: 1, name: "delta" }),
			{ type: "message" },
			said({ v: 1, name: null }),
		];

		expect(lastRecorded(branch)).toBeNull();
		expect(lastRecorded(branch.slice(0, 2))).toBe("delta");
	});

	it("is nothing on a branch with no budget entry", () => {
		expect(lastRecorded([{ type: "message" }])).toBeUndefined();
	});

	it("passes over an entry of another version or shape", () => {
		const branch = [
			said({ v: 1, name: "delta" }),
			said({ v: 2, name: "later" }),
			said({ v: 1, name: 7 }),
			{ type: "custom", customType: "other", data: { v: 1, name: null } },
		];

		expect(lastRecorded(branch)).toBe("delta");
	});
});
