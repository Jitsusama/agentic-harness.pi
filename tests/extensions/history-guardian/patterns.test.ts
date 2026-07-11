import { describe, expect, it } from "vitest";
import { historyGuardian } from "../../../extensions/history-guardian/review.js";

describe("historyGuardian.detect", () => {
	it("detects each irrecoverable form", () => {
		for (const cmd of [
			"git push --force",
			"git reset --hard",
			"git clean -fd",
			"git branch -D feature",
			"git checkout -- .",
		]) {
			expect(historyGuardian.detect(cmd)).toBe(true);
		}
	});

	it("ignores a non-destructive command", () => {
		expect(historyGuardian.detect("git status")).toBe(false);
		expect(historyGuardian.detect("git commit -m x")).toBe(false);
	});
});

describe("historyGuardian.parse", () => {
	it("grades --force-with-lease as risky and --force as irrecoverable", () => {
		// Ordering is load-bearing: the lease pattern must win over the
		// bare --force pattern, or a safer command is graded as the
		// harsher severity.
		expect(historyGuardian.parse("git push --force-with-lease")?.severity).toBe(
			"risky",
		);
		expect(historyGuardian.parse("git push --force")?.severity).toBe(
			"irrecoverable",
		);
	});

	it("grades rebase as risky and reset --hard as irrecoverable", () => {
		expect(historyGuardian.parse("git rebase -i HEAD~2")?.severity).toBe(
			"risky",
		);
		expect(historyGuardian.parse("git reset --hard")?.severity).toBe(
			"irrecoverable",
		);
	});

	it("returns null for an undetected command", () => {
		expect(historyGuardian.parse("git status")).toBeNull();
	});
});
