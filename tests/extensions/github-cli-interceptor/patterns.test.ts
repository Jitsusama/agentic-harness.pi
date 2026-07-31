import { describe, expect, it } from "vitest";
import {
	detectDeleteBranchOnMerge,
	detectInlineBody,
} from "../../../extensions/github-cli-interceptor/patterns.js";

describe("detectInlineBody", () => {
	it("blocks an inline --body", () => {
		expect(detectInlineBody('gh pr create --body "x"')).not.toBeNull();
	});

	it("blocks the short -b form", () => {
		expect(detectInlineBody('gh pr create -b "x"')).not.toBeNull();
	});

	it("allows the body-file heredoc form", () => {
		expect(
			detectInlineBody("gh pr create --body-file - <<'EOF'\nx\nEOF"),
		).toBeNull();
	});

	it("ignores a command that is not gh pr/issue", () => {
		expect(detectInlineBody('git commit -m "x"')).toBeNull();
	});
});

describe("detectDeleteBranchOnMerge", () => {
	it("blocks the long flag, because the auto-close it causes is permanent", () => {
		expect(
			detectDeleteBranchOnMerge("gh pr merge 12 --merge --delete-branch"),
		).toMatch(/cannot be reopened/);
	});

	it("blocks the short -d form", () => {
		expect(
			detectDeleteBranchOnMerge("gh pr merge 12 --merge -d"),
		).not.toBeNull();
	});

	it("names the safe sequence rather than only the hazard", () => {
		const reason = detectDeleteBranchOnMerge("gh pr merge 12 -d") ?? "";

		expect(reason).toContain("git push origin --delete");
		expect(reason).toContain("gh pr list --base");
	});

	it("allows a merge that leaves the branch alone", () => {
		expect(detectDeleteBranchOnMerge("gh pr merge 12 --merge")).toBeNull();
	});

	it("does not fire on a flag that merely starts with -d", () => {
		expect(detectDeleteBranchOnMerge("gh pr merge 12 --dry-run")).toBeNull();
	});

	it("ignores deleting a branch outside a merge, which is the fix we ask for", () => {
		expect(
			detectDeleteBranchOnMerge("git push origin --delete feature"),
		).toBeNull();
	});
});
