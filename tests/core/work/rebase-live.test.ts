/**
 * Whether a branch is already on its base, and what becomes of a commit the
 * base already carries, asked of real git.
 *
 * A branch just cut from main and asked onto a branch built on main holds no
 * commit of its own, which the rebaser once took to mean it was there
 * already, and so left it on main. Run against real git, since what counts
 * as there is git's history to say.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnExec } from "../../../lib/core/exec/index.ts";
import { createGitRebaser } from "../../../lib/core/work/rebase.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let repo: string;

beforeEach(async () => {
	repo = await freshRepo("rebase-live");
	await git(repo, "commit", "-q", "--allow-empty", "-m", "start");
	await git(repo, "checkout", "-q", "-b", "base");
	await git(repo, "commit", "-q", "--allow-empty", "-m", "on base");
	await git(repo, "checkout", "-q", "main");
});

afterEach(() => {
	disposeRepo(repo);
});

async function head(ref = "HEAD"): Promise<string> {
	return (await git(repo, "rev-parse", ref)).trim();
}

/** Write a file and commit it, on whatever branch is checked out. */
async function commit(path: string, text: string, subject: string) {
	writeFileSync(join(repo, path), text);
	await git(repo, "add", path);
	await git(repo, "commit", "-q", "-m", subject);
}

/** The subjects of the commits above the base, oldest first. */
async function above(): Promise<string[]> {
	const said = await git(repo, "log", "--reverse", "--format=%s", "base..HEAD");
	return said.trim().split("\n").filter(Boolean);
}

/**
 * A log both main and the base start with, so a conflict in it has a common
 * ancestor, as an appended log's does, rather than being two new files.
 */
async function seedLog() {
	await commit("log.md", "# Log\n", "log");
	await git(repo, "checkout", "-q", "base");
	await git(repo, "rebase", "-q", "main");
	await git(repo, "checkout", "-q", "main");
}

/** A topic of two commits, the second of which also lands on the base. */
async function topicWithOneLanded(path: string, text: string) {
	await git(repo, "checkout", "-q", "-b", "topic");
	await commit("mine.txt", "only on topic\n", "marker");
	await commit(path, text, "carried");
	await git(repo, "checkout", "-q", "base");
	await git(repo, "cherry-pick", "topic");
}

describe("a branch with no commits of its own", () => {
	it("moves up to a base that moved on", async () => {
		await git(repo, "checkout", "-q", "-b", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed", commits: 0 });
		expect(await head()).toBe(await head("base"));
	});

	it("stays put on the base it sits on", async () => {
		await git(repo, "checkout", "-q", "-b", "topic");
		const before = await head();

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"main",
		);

		expect(outcome).toMatchObject({ kind: "already-there" });
		expect(await head()).toBe(before);
	});
});

describe("a commit its base already carries", () => {
	it("drops as empty when the base left it as it landed", async () => {
		await topicWithOneLanded("both.txt", "the same change\n");
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed" });
		expect(await above()).toEqual(["marker"]);
	});

	it("comes back when the base has since reverted it", async () => {
		// Matching patches ahead of time would drop it as landed, and with it
		// the change the base no longer has. Replayed, it stays in sight.
		await topicWithOneLanded("both.txt", "the same change\n");
		await git(repo, "revert", "--no-edit", "HEAD");
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed" });
		expect(await above()).toEqual(["marker", "carried"]);
	});

	it("halts unsettled, saying where it landed, when the base has since edited its Markdown", async () => {
		// Both wordings read as additions over the commit's parent, so the
		// append settler would keep the old beside the new.
		await seedLog();
		await topicWithOneLanded("log.md", "# Log\n\n## 1. First\n\nOne.\n");
		await commit("log.md", "# Log\n\n## 1. First\n\nOne, edited.\n", "edit");
		const landedAs = (await git(repo, "rev-parse", "--short", "HEAD~1")).trim();
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["log.md"],
			landed: { as: landedAs, paths: ["log.md"] },
		});
		expect(outcome).not.toHaveProperty("settled");
		expect(readFileSync(join(repo, "log.md"), "utf8")).toContain("<<<<<<<");
	});

	it("still settles Markdown both sides only added to when it never landed", async () => {
		await seedLog();
		await git(repo, "checkout", "-q", "-b", "topic");
		await commit("log.md", "# Log\n\n## Mine\n", "mine");
		await git(repo, "checkout", "-q", "base");
		await commit("log.md", "# Log\n\n## Theirs\n", "theirs");
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed" });
		expect(outcome).not.toHaveProperty("landed");
		expect(await above()).toEqual(["mine"]);
	});
});
