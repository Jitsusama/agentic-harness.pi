import { describe, expect, it } from "vitest";
import { isSubstantiveTurn } from "../../../extensions/advisor/substantive.js";

describe("isSubstantiveTurn", () => {
	it("is substantive when the turn changed or acted", () => {
		expect(isSubstantiveTurn(["read", "edit"])).toBe(true);
		expect(isSubstantiveTurn(["write"])).toBe(true);
		expect(isSubstantiveTurn(["pr_workflow"])).toBe(true);
		expect(isSubstantiveTurn(["reply_to_thread"])).toBe(true);
	});

	it("is not substantive for a read-only turn", () => {
		expect(isSubstantiveTurn(["read", "grep", "glob", "ls"])).toBe(false);
		expect(isSubstantiveTurn([])).toBe(false);
	});
});
