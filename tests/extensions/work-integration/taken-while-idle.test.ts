/**
 * What the work tool's listing says of the worktrees the sweep took from
 * its session: each branch at the head kept for it, and how to have it
 * again, read from the notes the sweep leaves for that session alone.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { takenWhileIdle } from "../../../extensions/work-integration/tools/listing.ts";
import {
	branchesKeptForSession,
	keepBranch,
} from "../../../lib/core/work/sweep-kept-branches.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A folder of notes, removed after the test. */
function notesFolder(): string {
	const dir = mkdtempSync(join(tmpdir(), "kept-branches-"));
	dirs.push(dir);
	return dir;
}

describe("telling a session which of its trees the sweep took", () => {
	it("names each branch and its head, oldest first, and how to have one again", () => {
		const dir = notesFolder();
		keepBranch(dir, {
			checkout: "/src/core",
			branch: "later",
			commit: "b".repeat(40),
			path: "/trees/later",
			sessions: ["01ours"],
			takenAt: 2000,
		});
		keepBranch(dir, {
			checkout: "/src/core",
			branch: "earlier",
			commit: "a".repeat(40),
			path: "/trees/earlier",
			sessions: ["01other", "01ours"],
			takenAt: 1000,
		});

		const said = takenWhileIdle(branchesKeptForSession(dir, "01ours"));

		expect(said).toContain(
			`earlier at ${"a".repeat(12)}, later at ${"b".repeat(12)}`,
		);
		expect(said).toContain("Ask with action 'tree' and its branch");
	});

	it("says nothing of another session's, or when none went", () => {
		const dir = notesFolder();
		keepBranch(dir, {
			checkout: "/src/core",
			branch: "theirs",
			commit: "c".repeat(40),
			path: "/trees/theirs",
			sessions: ["01other"],
			takenAt: 1000,
		});

		expect(takenWhileIdle(branchesKeptForSession(dir, "01ours"))).toBe("");
		expect(
			takenWhileIdle(branchesKeptForSession(join(dir, "none"), "01ours")),
		).toBe("");
	});
});
