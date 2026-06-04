import { describe, expect, it } from "vitest";
import {
	QUEST_ACTIONS,
	suggestAction,
} from "../../../extensions/quest-workflow/actions";

describe("suggestAction", () => {
	it("returns a close match for a one-letter typo", () => {
		expect(suggestAction("lst")).toBe("list");
		expect(suggestAction("shw")).toBe("show");
		expect(suggestAction("stat")).toBe("status");
	});

	it("returns undefined when no canonical action is close", () => {
		expect(suggestAction("xyz123nothing")).toBeUndefined();
	});

	it("matches exact action names", () => {
		expect(suggestAction("show")).toBe("show");
		expect(suggestAction("status")).toBe("status");
	});

	it("includes status in the canonical list", () => {
		const list: readonly string[] = QUEST_ACTIONS;
		expect(list).toContain("status");
		expect(list).toContain("show");
	});
});
