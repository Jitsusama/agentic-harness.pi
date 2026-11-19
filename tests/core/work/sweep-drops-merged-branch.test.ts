/**
 * The sweep letting go of branches origin's trunk already has.
 *
 * Released trees left their branches: on 19 November core.nix's
 * checkout held 5,734 local branches and 4,691 `[branch]` sections,
 * 518 KB of config every git command there read. Releasing a tree now
 * takes its merged branch, but a tree the sweep takes, and a branch
 * that merged after its tree went, were still left. These run real git,
 * since what matters is what git is left holding.
 */

import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUSHED_SETTLE_MS } from "../../../lib/core/work/sweep.ts";
import { git } from "../../support/git-fixture.ts";
import {
	disposeAll,
	exec,
	landed,
	RUNNING,
	setUp,
} from "./support/sweep-live.ts";

afterEach(disposeAll);

/** The branches `main` holds, by short name. */
async function branchesOf(main: string): Promise<string[]> {
	const listed = await git(
		main,
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads/",
	);
	return listed.split("\n").filter((line) => line !== "");
}

/** A branch's `[branch]` section in `main`'s config, or "" when it has none. */
async function sectionOf(main: string, branch: string): Promise<string> {
	const answer = await exec("git", [
		"-C",
		main,
		"config",
		"--get-regexp",
		`^branch\\.${branch.replaceAll("/", "\\/").replaceAll(".", "\\.")}\\.`,
	]);
	// Exit 1 is git saying no key matched.
	if (answer.code === 1) return "";
	if (answer.code !== 0) throw new Error(`git config said ${answer.stderr}`);
	return answer.stdout.trim();
}

/** Put a branch's reflog two days back, as a branch nobody has moved. */
function settleBranch(main: string, branch: string): void {
	const then = new Date(Date.now() - 2 * PUSHED_SETTLE_MS);
	utimesSync(join(main, ".git", "logs", "refs", "heads", branch), then, then);
}

/** Make `branch` at main with one commit of its own, and no tree left on it. */
async function ahead(
	main: string,
	state: string,
	branch: string,
): Promise<void> {
	const tree = join(state, `making-${branch.replaceAll("/", "-")}`);
	await git(main, "worktree", "add", "-q", "-b", branch, tree, "main");
	await git(tree, "commit", "-q", "--allow-empty", "-m", `work on ${branch}`);
	await git(main, "worktree", "remove", tree);
}

describe("a tree the sweep takes", () => {
	it("takes its branch with it when origin's trunk has all of it", async () => {
		const { main, cut, sweep } = await setUp();
		const tree = await cut("done", ["-b", "jg/done", "@", "main"]);
		await git(main, "config", "branch.jg/done.remote", "origin");

		const outcome = await sweep();

		expect(outcome.taken).toEqual([
			{ path: tree, branch: "jg/done", branchGone: true },
		]);
		expect(await branchesOf(main)).not.toContain("jg/done");
		expect(await sectionOf(main, "jg/done")).toBe("");
	});

	it("keeps the branch of a squash-landed tree, whose commit trunk lacks", async () => {
		const { main, cut, sweep } = await setUp();
		const tree = await landed(cut, "landed");
		const then = new Date(Date.now() - 2 * PUSHED_SETTLE_MS);
		const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
		for (const one of ["HEAD", join("logs", "HEAD")]) {
			utimesSync(join(gitDir, one), then, then);
		}

		const outcome = await sweep();

		expect(outcome.taken).toEqual([
			{ path: tree, branch: "landed", remote: "origin/landed" },
		]);
		expect(await branchesOf(main)).toContain("landed");
	});
});

describe("branches with no tree on them", () => {
	it("drops a settled one origin's trunk has, with its config section", async () => {
		const { main, cut, sweep } = await setUp();
		// A tree a running session holds, so the sweep knows the checkout.
		await cut("live", ["-b", "live", "@", "main"], [RUNNING]);
		await git(main, "branch", "jg/old", "main");
		await git(main, "config", "branch.jg/old.remote", "origin");
		settleBranch(main, "jg/old");

		const outcome = await sweep();

		expect(outcome.branches).toEqual([{ checkout: main, gone: 1 }]);
		expect(await branchesOf(main)).not.toContain("jg/old");
		expect(await sectionOf(main, "jg/old")).toBe("");
		expect(await branchesOf(main)).toContain("live");
	});

	it("keeps every one that could still be somebody's work", async () => {
		const { main, state, cut, sweep } = await setUp();
		await cut("live", ["-b", "live", "@", "main"], [RUNNING]);
		// Merged, but moved within the day: a session may have just made it.
		await git(main, "branch", "fresh", "main");
		// A commit of its own that origin's trunk lacks, pushed or not.
		await ahead(main, state, "unpushed");
		await ahead(main, state, "pushed");
		await git(main, "push", "-q", "origin", "pushed");
		// Merged, but another branch is stacked on it.
		await git(main, "branch", "parent", "main");
		await ahead(main, state, "child");
		await git(main, "config", "branch.child.workparent", "parent");
		// Merged, with no reflog to say when it last moved.
		await git(main, "branch", "unlogged", "main");
		rmSync(join(main, ".git", "logs", "refs", "heads", "unlogged"));
		for (const one of ["live", "unpushed", "pushed", "parent", "child"]) {
			settleBranch(main, one);
		}

		const outcome = await sweep();

		expect(outcome.branches).toEqual([]);
		expect((await branchesOf(main)).sort()).toEqual(
			[
				"child",
				"fresh",
				"live",
				"main",
				"parent",
				"pushed",
				"unlogged",
				"unpushed",
			].sort(),
		);
	});
});
