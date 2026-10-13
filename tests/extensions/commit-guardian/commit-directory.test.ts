import { describe, expect, it } from "vitest";
import { commitDirectory } from "../../../extensions/commit-guardian/parse.ts";

describe("where a commit lands", () => {
	it("is the session's directory for a bare commit", () => {
		expect(commitDirectory("git commit -m 'fix: x'", "/session")).toBe(
			"/session",
		);
	});

	it("follows the cd segments before it", () => {
		expect(
			commitDirectory(
				"cd /work && cd tree && git add -A && git commit -m 'fix: x'",
				"/session",
			),
		).toBe("/work/tree");
	});

	it("follows git -C, applied in order, past other global options", () => {
		expect(
			commitDirectory(
				"git -C /work -c user.name=x -C tree commit -m 'fix: x'",
				"/session",
			),
		).toBe("/work/tree");
		expect(commitDirectory("git -C'/work/my tree' commit -m x", "/s")).toBe(
			"/work/my tree",
		);
	});

	it("is not a guess when a cd cannot be resolved", () => {
		expect(
			commitDirectory('cd "$TREE" && git commit -m x', "/session"),
		).toBeUndefined();
	});
});
