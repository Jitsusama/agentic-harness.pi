import { describe, expect, it } from "vitest";
import { isCommitCommand } from "../../../extensions/commit-guardian/parse.ts";

describe("isCommitCommand", () => {
	it("detects a plain git commit", () => {
		expect(isCommitCommand('git commit -m "x"'), "git commit").toBe(true);
	});

	it("detects a commit reached through a leading git global option", () => {
		expect(
			isCommitCommand("git -C /tmp/x commit -m x"),
			"git -C <dir> commit",
		).toBe(true);
	});

	it("does not detect a non-commit git command", () => {
		expect(isCommitCommand("git status"), "git status").toBe(false);
	});
});
