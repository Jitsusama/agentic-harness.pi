/**
 * What the work tool's listing says of the worktrees the sweep took from
 * its session: each branch at the head kept for it, and how to have it
 * again, read from the notes the sweep leaves for that session alone.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { takenWhileIdle } from "../../../extensions/work-integration/tools/listing.ts";
import {
	branchesKeptFor,
	branchesKeptForSession,
	keepBranch,
	keptBranches,
} from "../../../lib/core/work/sweep-kept-branches.ts";

/** An exec that runs nothing, for notes whose branch no checkout holds. */
const nothingRun = async () => ({ code: 1, stdout: "", stderr: "" });

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * A worktree's folder under `dir` named `name`, its `.git` file naming a
 * git folder whose HEAD is on `branch`, as git leaves one.
 */
function worktreeAt(dir: string, name: string, branch: string): string {
	const path = join(dir, name);
	const gitDir = join(dir, "git", name);
	mkdirSync(path, { recursive: true });
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(path, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	return path;
}

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

	it("orders by when each went, whatever order the notes are read in", () => {
		const dir = notesFolder();
		const branches = ["m", "z", "a", "q", "c", "k"];
		for (const [at, branch] of branches.entries()) {
			keepBranch(dir, {
				checkout: "/src/core",
				branch,
				commit: "d".repeat(40),
				path: `/trees/${branch}`,
				sessions: ["01ours"],
				takenAt: at,
			});
		}

		expect(
			branchesKeptForSession(dir, "01ours").map((one) => one.branch),
		).toEqual(branches);
	});

	it("keeps telling of a tree while something else stands at its path", async () => {
		const dir = notesFolder();
		const path = worktreeAt(dir, "taken", "someone-elses");
		keepBranch(dir, {
			checkout: "/src/core",
			branch: "taken",
			commit: "e".repeat(40),
			path,
			sessions: ["01ours"],
			takenAt: 1000,
		});

		expect(branchesKeptForSession(dir, "01ours")).toHaveLength(1);
		const kept = await branchesKeptFor(nothingRun, dir, new Set(["01ours"]));
		expect(kept.get("/src/core")).toEqual(new Set(["taken"]));
	});

	it("says nothing more of a tree once it stands again, and lets its note go", async () => {
		const dir = notesFolder();
		const again = worktreeAt(dir, "cut-again", "asked-again");
		keepBranch(dir, {
			checkout: "/src/core",
			branch: "asked-again",
			commit: "e".repeat(40),
			path: again,
			sessions: ["01ours"],
			takenAt: 1000,
		});

		expect(takenWhileIdle(branchesKeptForSession(dir, "01ours"))).toBe("");
		const kept = await branchesKeptFor(nothingRun, dir, new Set(["01ours"]));
		expect([...kept.keys()]).toEqual([]);
		expect(keptBranches(dir)).toEqual([]);
	});

	it("keeps every session a branch was taken from, and undoes a take that stayed", () => {
		const dir = notesFolder();
		const note = {
			checkout: "/src/core",
			branch: "twice",
			commit: "f".repeat(40),
			path: "/trees/twice",
			takenAt: 1000,
		};
		keepBranch(dir, { ...note, sessions: ["01first"] });
		const undo = keepBranch(dir, { ...note, sessions: ["01second"] });

		expect(branchesKeptForSession(dir, "01first")).toHaveLength(1);
		expect(branchesKeptForSession(dir, "01second")).toHaveLength(1);
		undo();
		expect(branchesKeptForSession(dir, "01first")).toHaveLength(1);
		expect(branchesKeptForSession(dir, "01second")).toEqual([]);
		expect(
			readdirSync(dir).filter((name) => !name.endsWith(".json")),
			"files left aside",
		).toEqual([]);
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
