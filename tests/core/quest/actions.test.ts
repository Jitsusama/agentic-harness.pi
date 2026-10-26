import { describe, expect, it } from "vitest";
import {
	QUEST_ACTIONS,
	suggestAction,
} from "../../../lib/core/quest/actions.ts";

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

	it("includes the verbs that edit a quest document's body", () => {
		const list: readonly string[] = QUEST_ACTIONS;
		for (const verb of ["journal", "tick", "untick", "section"]) {
			expect(list).toContain(verb);
		}
	});
});
