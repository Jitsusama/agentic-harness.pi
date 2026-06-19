import { describe, expect, it } from "vitest";
import type { WorktreeHandle } from "../../../extensions/pr-workflow/worktree.js";
import { selectWorktreeBySha } from "../../../extensions/pr-workflow/worktree-select.js";

function handle(sha: string): WorktreeHandle {
	return {
		path: `/wt/${sha}`,
		sha,
		providerId: "fake",
		reusable: true,
		createdAt: new Date(0),
		marker: `pi-pr-workflow-${sha}`,
	};
}

/**
 * `selectWorktreeBySha` backs the worktree-cleanup verb: the
 * user passes a sha (or a prefix of one worktree-list printed)
 * and we resolve it to exactly one handle, refusing to guess
 * when a prefix matches more than one tree.
 */
describe("selectWorktreeBySha", () => {
	const handles = [handle("0123456789ab"), handle("abcdef012345")];

	it("finds the handle whose sha matches exactly", () => {
		expect(selectWorktreeBySha(handles, "0123456789ab")).toEqual({
			status: "found",
			handle: handles[0],
		});
	});

	it("finds the handle a unique prefix points at", () => {
		expect(selectWorktreeBySha(handles, "abcdef")).toEqual({
			status: "found",
			handle: handles[1],
		});
	});

	it("reports missing when no sha matches", () => {
		expect(selectWorktreeBySha(handles, "deadbeef")).toEqual({
			status: "missing",
		});
	});

	it("reports missing for a blank sha", () => {
		expect(selectWorktreeBySha(handles, "  ")).toEqual({ status: "missing" });
	});

	it("reports ambiguity when a prefix matches more than one", () => {
		const collide = [handle("0123aaaa"), handle("0123bbbb")];
		expect(selectWorktreeBySha(collide, "0123")).toEqual({
			status: "ambiguous",
			matches: collide,
		});
	});

	it("prefers an exact match over a longer sha that shares the prefix", () => {
		const nested = [handle("0123"), handle("01234567")];
		expect(selectWorktreeBySha(nested, "0123")).toEqual({
			status: "found",
			handle: nested[0],
		});
	});
});
