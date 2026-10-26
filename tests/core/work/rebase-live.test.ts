/**
 * Whether a branch is already on its base, asked of real git.
 *
 * A branch just cut from main and asked onto a branch built on main holds no
 * commit of its own, which the rebaser once took to mean it was there
 * already, and so left it on main. Run against real git, since what counts
 * as there is git's history to say.
 */

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
