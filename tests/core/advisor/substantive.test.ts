import { describe, expect, it } from "vitest";
import { isSubstantiveTurn } from "../../../lib/core/advisor/substantive.ts";

describe("isSubstantiveTurn", () => {
	it("is substantive when the turn changed or acted", () => {
		expect(isSubstantiveTurn(["read", "edit"]), "a turn that edits").toBe(true);
		expect(isSubstantiveTurn(["write"]), "a turn that writes").toBe(true);
		expect(isSubstantiveTurn(["pr_workflow"]), "a turn that acts on a PR").toBe(
			true,
		);
		expect(
			isSubstantiveTurn(["reply_to_thread"]),
			"a turn that replies to a thread",
		).toBe(true);
	});

	it("is not substantive for a read-only turn", () => {
		expect(
			isSubstantiveTurn(["read", "grep", "glob", "ls"]),
			"a turn that only reads and searches",
		).toBe(false);
		expect(isSubstantiveTurn([]), "a turn with no tools").toBe(false);
	});
});
