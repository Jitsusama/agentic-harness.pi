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
async function seedLog(text = "# Log\n") {
	await commit("log.md", text, "log");
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

/**
 * What a replay of topic's tip should say landed: the commit and the one
 * the base carries it as, read with the base checked out after the landing
 * and anything committed on top of it.
 */
async function landing() {
	const as = (
		await git(repo, "log", "--format=%h", "--grep=^carried$", "-1", "base")
	).trim();
	const commit = (await git(repo, "rev-parse", "--short", "topic")).trim();
	return { commit, as, paths: ["log.md"] };
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

/**
 * Work that merged into trunk, with the base holding a copy of its first
 * commit from before it merged, and trunk moving on after the merge. The
 * branch is left checked out at the merge, as core.nix's forage-floor-gaps
 * was on 23 November when a replay put seven of main's commits back.
 */
async function atTrunkMergeOverCopies() {
	await git(repo, "checkout", "-q", "-b", "work", "main");
	await commit("work.txt", "first\n", "work one");
	await commit("more.txt", "second\n", "work two");
	await git(repo, "checkout", "-q", "base");
	await git(repo, "cherry-pick", "work~1");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "merge", "-q", "--no-ff", "-m", "merge work", "work");
	await git(repo, "checkout", "-q", "-b", "topic");
	await git(repo, "checkout", "-q", "main");
	await commit("later.txt", "main moved on\n", "later on main");
	await git(repo, "update-ref", "refs/remotes/origin/main", "main");
	await git(repo, "checkout", "-q", "topic");
}

/**
 * A branch that meets its base at two commits: trunk merged x and y and
 * moved on, the base merged x and either y, so both meetings are trunk's,
 * or w, side work trunk never took, which the branch merged too. The
 * branch has one commit of its own.
 */
async function crissCross(shape: "both on trunk" | "one off trunk") {
	for (const name of ["x", "y", "w"]) {
		const path = `${name}.txt`;
		await git(repo, "checkout", "-q", "-b", `${name}`, "main");
		await commit(`${path}`, `${name}\n`, `${name} one`);
	}
	await git(repo, "checkout", "-q", "main");
	await git(repo, "merge", "-q", "--no-ff", "-m", "merge x", "x");
	await git(repo, "merge", "-q", "--no-ff", "-m", "merge y", "y");
	await commit("later.txt", "main moved on\n", "later on main");
	await git(repo, "update-ref", "refs/remotes/origin/main", "main");
	const second = shape === "both on trunk" ? "y" : "w";
	await git(repo, "checkout", "-q", "base");
	await git(repo, "merge", "-q", "--no-edit", "x");
	await git(repo, "merge", "-q", "--no-edit", second);
	await git(repo, "checkout", "-q", "-b", "topic", "main");
	if (shape === "one off trunk") {
		await git(repo, "merge", "-q", "--no-edit", "w");
	}
	await commit("mine.txt", "only on topic\n", "mine");
	const meetings = await git(repo, "merge-base", "--all", "topic", "base");
	if (meetings.split("\n").length !== 2) {
		throw new Error(`topic meets base at ${meetings}, not at two commits`);
	}
}

describe("a branch that leaves trunk at a merge", () => {
	it("is refused onto a base lacking trunk's commits when it has none of its own", async () => {
		await atTrunkMergeOverCopies();
		const before = await head();

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(
			outcome,
			"a branch wholly on trunk neither carries trunk nor becomes the base",
		).toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("already on origin/main"),
		});
		expect(await head(), "the branch stays where it was").toBe(before);
	});

	it("replays only its own commits above trunk, and says what it left", async () => {
		await atTrunkMergeOverCopies();
		await commit("mine.txt", "only on topic\n", "mine");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(
			outcome,
			"one commit of its own, and work one and two left on trunk",
		).toMatchObject({
			kind: "replayed",
			commits: 1,
			trunk: { name: "origin/main", left: 2 },
		});
		expect(await above(), "trunk's commits stay off the branch").toEqual([
			"mine",
		]);
	});

	it("halts on a conflict, and resumes with only its own commits", async () => {
		await atTrunkMergeOverCopies();
		await commit("mine.txt", "only on topic\n", "mine");
		await git(repo, "checkout", "-q", "base");
		await commit("mine.txt", "on base too\n", "base's mine");
		await git(repo, "checkout", "-q", "topic");
		const rebaser = createGitRebaser({ exec: spawnExec() });

		const halted = await rebaser.rebase(repo, "base");

		expect(halted, "the replay stops on mine.txt").toMatchObject({
			kind: "halted",
			onto: "base",
			conflicted: ["mine.txt"],
			trunk: { name: "origin/main", left: 2 },
		});
		writeFileSync(join(repo, "mine.txt"), "settled\n");
		const resumed = await rebaser.resume(repo);
		expect(resumed, "the settled replay ends").toMatchObject({
			kind: "replayed",
			branch: "topic",
		});
		expect(await above(), "only its own commit is on the base").toEqual([
			"mine",
		]);
	});

	it("abandons a halted replay back to the merge it sat on", async () => {
		await atTrunkMergeOverCopies();
		await commit("mine.txt", "only on topic\n", "mine");
		const before = await head();
		await git(repo, "checkout", "-q", "base");
		await commit("mine.txt", "on base too\n", "base's mine");
		await git(repo, "checkout", "-q", "topic");
		const rebaser = createGitRebaser({ exec: spawnExec() });
		expect(
			await rebaser.rebase(repo, "base"),
			"the replay stops on mine.txt",
		).toMatchObject({ kind: "halted" });

		const abandoned = await rebaser.abandon(repo);

		expect(abandoned, "the replay is backed out").toMatchObject({
			kind: "abandoned",
		});
		expect(await head(), "the branch is back where it was").toBe(before);
	});

	it("is refused when stacked on a base it shares commits with off trunk", async () => {
		await atTrunkMergeOverCopies();
		await git(repo, "checkout", "-q", "-b", "stacked", "base");
		await commit("stacked.txt", "one\n", "stacked one");
		await git(repo, "merge", "-q", "--no-edit", "origin/main");
		await commit("stacked.txt", "two\n", "stacked two");
		await git(repo, "checkout", "-q", "base");
		await commit("base.txt", "moved\n", "base moved on");
		await git(repo, "checkout", "-q", "stacked");
		const before = await head();

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(
			outcome,
			"a replay from trunk would pick the base's own commits again",
		).toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("Replay base onto origin/main first"),
		});
		expect(await head(), "the branch stays where it was").toBe(before);
	});

	it("leaves a branch on a base it holds, though it merged trunk above it", async () => {
		// git flattens a range holding a merge, so a replay here would carry
		// trunk's merged commits onto the branch as its own.
		await atTrunkMergeOverCopies();
		await git(repo, "checkout", "-q", "-b", "stacked", "base");
		await commit("stacked.txt", "one\n", "stacked one");
		await git(repo, "merge", "-q", "--no-edit", "origin/main");
		await commit("stacked.txt", "two\n", "stacked two");
		const before = await head();

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome, "a base it holds was replayed onto").toMatchObject({
			kind: "already-there",
		});
		expect(await head(), "the branch was rewritten").toBe(before);
	});

	it("names a base git doesn't know, though trunk is there to judge by", async () => {
		await atTrunkMergeOverCopies();
		const before = await head();

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"nope",
		);

		expect(outcome, "the missing base read as trunk trouble").toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("nope isn't a commit git knows"),
		});
		expect(await head(), "the branch moved").toBe(before);
	});

	it("keeps its own commits on both sides of a merge of trunk", async () => {
		await git(repo, "checkout", "-q", "-b", "work", "main");
		await commit("work.txt", "first\n", "work one");
		await commit("more.txt", "second\n", "work two");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "cherry-pick", "work~1");
		await git(repo, "checkout", "-q", "-b", "topic", "main");
		await commit("own.txt", "one\n", "own one");
		await git(repo, "checkout", "-q", "main");
		await git(repo, "merge", "-q", "--no-ff", "-m", "merge work", "work");
		await commit("later.txt", "main moved on\n", "later on main");
		await git(repo, "update-ref", "refs/remotes/origin/main", "main");
		await git(repo, "checkout", "-q", "topic");
		await git(repo, "merge", "-q", "--no-edit", "origin/main");
		await commit("own.txt", "two\n", "own two");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome, "its two commits, and trunk's three left").toMatchObject({
			kind: "replayed",
			commits: 2,
			trunk: { name: "origin/main", left: 3 },
		});
		expect(await above(), "a commit of its own was lost").toEqual([
			"own one",
			"own two",
		]);
	});

	it("cuts at trunk when the branch meets its base at two of trunk's commits", async () => {
		await crissCross("both on trunk");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome, "trunk's later commit wasn't left").toMatchObject({
			kind: "replayed",
			commits: 1,
			trunk: { name: "origin/main", left: 1 },
		});
		expect(await above(), "trunk's commits came along").toEqual(["mine"]);
	});

	it("is refused when one of two meetings with its base is off trunk", async () => {
		await crissCross("one off trunk");
		const before = await head();

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome, "a meeting off trunk went unchecked").toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("Replay base onto origin/main first"),
		});
		expect(await head(), "the branch moved").toBe(before);
	});

	it("replays as git does in a checkout with no remote trunk", async () => {
		await atTrunkMergeOverCopies();
		await commit("mine.txt", "only on topic\n", "mine");
		await git(repo, "update-ref", "-d", "refs/remotes/origin/main");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		// The known gap, not the aim: with no trunk to judge by, trunk's work
		// two is carried as the branch's own, and the answer says it couldn't
		// judge. A change that refused here instead would be safer.
		expect(outcome, "the replay doesn't say trunk went unjudged").toMatchObject(
			{
				kind: "replayed",
				unjudged: true,
			},
		);
		expect(
			outcome,
			"the copy of work one git dropped was counted as replayed",
		).toMatchObject({ commits: 2 });
		expect(outcome, "a cut was claimed with no trunk").not.toHaveProperty(
			"trunk",
		);
		expect(
			await above(),
			"every commit the base lacks is replayed, its copy of work one dropped",
		).toEqual(["work two", "mine"]);
	});

	it("refuses a base that git would read as an option", async () => {
		await atTrunkMergeOverCopies();

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"--exec=true",
		);

		expect(outcome, "a dash opens an option, not a commit").toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("opens with a dash"),
		});
	});

	it("still takes trunk's commits when replayed onto trunk", async () => {
		await atTrunkMergeOverCopies();
		await commit("mine.txt", "only on topic\n", "mine");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"origin/main",
		);

		expect(outcome, "one commit of its own").toMatchObject({
			kind: "replayed",
			commits: 1,
		});
		expect(
			outcome,
			"trunk holds all it has, so none is cut",
		).not.toHaveProperty("trunk");
		expect(await head("HEAD~1"), "it sits on trunk's tip").toBe(
			await head("main"),
		);
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

	it("keeps the base's side, saying where it landed, when the base has since edited its Markdown", async () => {
		// Both wordings read as additions over the commit's parent, so the
		// append settler would keep the old beside the new.
		await seedLog();
		await topicWithOneLanded("log.md", "# Log\n\n## 1. First\n\nOne.\n");
		await commit("log.md", "# Log\n\n## 1. First\n\nOne, edited.\n", "edit");
		const landed = await landing();
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed", landed: [landed] });
		expect(outcome).not.toHaveProperty("settled");
		expect(await above()).toEqual(["marker"]);
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(
			"# Log\n\n## 1. First\n\nOne, edited.\n",
		);
	});

	it("keeps the base's side when the base has only appended since it landed", async () => {
		// The usual shape in a busy log, where settling both sides as additions
		// would bring the landed entry back a second time.
		await seedLog();
		const entry = "# Log\n\n## 1. First\n\nOne.\n";
		await topicWithOneLanded("log.md", entry);
		await commit("log.md", `${entry}\n## 2. Later\n\nTwo.\n`, "later");
		const landed = await landing();
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed", landed: [landed] });
		expect(await above()).toEqual(["marker"]);
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(
			`${entry}\n## 2. Later\n\nTwo.\n`,
		);
	});

	it("keeps the base's side for a landed commit a resume reaches", async () => {
		// The first commit halts on a conflict only a person can settle; the
		// landed one comes up on the resume's own round.
		await seedLog();
		await commit("plain.txt", "start\n", "plain");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "rebase", "-q", "main");
		await git(repo, "checkout", "-q", "main");
		await git(repo, "checkout", "-q", "-b", "topic");
		await commit("plain.txt", "mine\n", "plain mine");
		const entry = "# Log\n\n## 1. First\n\nOne.\n";
		await commit("log.md", entry, "carried");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "cherry-pick", "topic");
		await commit("log.md", `${entry}\n## 2. Later\n\nTwo.\n`, "later");
		await commit("plain.txt", "theirs\n", "plain theirs");
		const landed = await landing();
		await git(repo, "checkout", "-q", "topic");
		const rebaser = createGitRebaser({ exec: spawnExec() });

		const halted = await rebaser.rebase(repo, "base");
		writeFileSync(join(repo, "plain.txt"), "both\n");
		const resumed = await rebaser.resume(repo);

		expect(halted).toMatchObject({ kind: "halted", conflicted: ["plain.txt"] });
		expect(resumed).toMatchObject({ kind: "replayed", landed: [landed] });
		expect(await above()).toEqual(["plain mine"]);
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(
			`${entry}\n## 2. Later\n\nTwo.\n`,
		);
	});

	it("keeps the base's side for a landed halt a raw continue reached", async () => {
		// The person settles the tool's halt and carries on with git itself,
		// which halts on the landed commit. The tool never asked about that
		// halt, so the resume starting from it must.
		await seedLog();
		await commit("plain.txt", "start\n", "plain");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "rebase", "-q", "main");
		await git(repo, "checkout", "-q", "main");
		await git(repo, "checkout", "-q", "-b", "topic");
		await commit("plain.txt", "mine\n", "plain mine");
		const entry = "# Log\n\n## 1. First\n\nOne.\n";
		await commit("log.md", entry, "carried");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "cherry-pick", "topic");
		await commit("log.md", `${entry}\n## 2. Later\n\nTwo.\n`, "later");
		await commit("plain.txt", "theirs\n", "plain theirs");
		const landed = await landing();
		await git(repo, "checkout", "-q", "topic");
		const carried = await head();
		const rebaser = createGitRebaser({ exec: spawnExec() });

		const halted = await rebaser.rebase(repo, "base");
		writeFileSync(join(repo, "plain.txt"), "both\n");
		await git(repo, "add", "plain.txt");
		const raw = await git(
			repo,
			"-c",
			"core.editor=true",
			"rebase",
			"--continue",
		).then(
			() => "replayed",
			() => "halted",
		);
		const stoppedOn = await head("REBASE_HEAD");
		const resumed = await rebaser.resume(repo);

		expect(halted).toMatchObject({ kind: "halted", conflicted: ["plain.txt"] });
		expect(raw).toBe("halted");
		expect(stoppedOn).toBe(carried);
		expect(resumed).toMatchObject({ kind: "replayed", landed: [landed] });
		expect(await above()).toEqual(["plain mine"]);
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(
			`${entry}\n## 2. Later\n\nTwo.\n`,
		);
	});

	it("leaves alone a landed log a person cleared of git's markers", async () => {
		// The person settles the landed halt a raw continue reached by hand,
		// keeping their own wording on purpose: once its markers are gone, the
		// file is theirs.
		await seedLog();
		await commit("plain.txt", "start\n", "plain");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "rebase", "-q", "main");
		await git(repo, "checkout", "-q", "main");
		await git(repo, "checkout", "-q", "-b", "topic");
		await commit("plain.txt", "mine\n", "plain mine");
		const entry = "# Log\n\n## 1. First\n\nOne.\n";
		await commit("log.md", entry, "carried");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "cherry-pick", "topic");
		await commit("log.md", `${entry}\n## 2. Later\n\nTwo.\n`, "later");
		await commit("plain.txt", "theirs\n", "plain theirs");
		await git(repo, "checkout", "-q", "topic");
		const rebaser = createGitRebaser({ exec: spawnExec() });
		const byHand = "# Log\n\n## 1. First\n\nOne, in my words.\n";

		await rebaser.rebase(repo, "base");
		writeFileSync(join(repo, "plain.txt"), "both\n");
		await git(repo, "add", "plain.txt");
		const raw = await git(
			repo,
			"-c",
			"core.editor=true",
			"rebase",
			"--continue",
		).then(
			() => "replayed",
			() => "halted",
		);
		const marked = readFileSync(join(repo, "log.md"), "utf8");
		writeFileSync(join(repo, "log.md"), byHand);
		const resumed = await rebaser.resume(repo);

		expect(raw).toBe("halted");
		expect(marked).toContain("<<<<<<<");
		expect(resumed).toMatchObject({ kind: "replayed" });
		expect(resumed).not.toHaveProperty("landed");
		expect(await above()).toEqual(["plain mine", "carried"]);
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(byHand);
	});

	it("halts on the code of a landed commit, saying its log kept the base's side", async () => {
		// The log is settled by the landing, but the code both sides changed
		// since is left to a person, and the halt is the only answer that can
		// say the branch's log entry gave way.
		await commit("code.txt", "start\n", "code");
		await seedLog();
		await git(repo, "checkout", "-q", "-b", "topic");
		await commit("mine.txt", "only on topic\n", "marker");
		const entry = "# Log\n\n## 1. First\n\nOne.\n";
		writeFileSync(join(repo, "code.txt"), "mine\n");
		await git(repo, "add", "code.txt");
		await commit("log.md", entry, "carried");
		await git(repo, "checkout", "-q", "base");
		await git(repo, "cherry-pick", "topic");
		await commit("log.md", `${entry}\n## 2. Later\n\nTwo.\n`, "later");
		await commit("code.txt", "theirs\n", "code theirs");
		const landed = await landing();
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["code.txt"],
			landed: [landed],
		});
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(
			`${entry}\n## 2. Later\n\nTwo.\n`,
		);
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

	it("finds a landing in a log written with CRLF", async () => {
		// The base's edit to the intro changes the log's blob ids, so the
		// landing is found only with blob ids left out of a text file, and the
		// file the base's side keeps still ends its lines in CR. Kept as
		// written, whatever the person's own config would make of line ends.
		await git(repo, "config", "core.autocrlf", "false");
		const seed = "# Log\r\n\r\nintro\r\n\r\na\r\nb\r\nc\r\nd\r\n";
		await seedLog(seed);
		await git(repo, "checkout", "-q", "base");
		await commit("log.md", seed.replace("intro", "intro, edited"), "intro");
		await git(repo, "checkout", "-q", "main");
		const entry = "\r\n## 1. First\r\n\r\nOne.\r\n";
		await topicWithOneLanded("log.md", `${seed}${entry}`);
		const after = `${seed.replace("intro", "intro, edited")}${entry}\r\n## 2. Later\r\n`;
		await commit("log.md", after, "later");
		const landed = await landing();
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed", landed: [landed] });
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(after);
	});

	it("takes the same change among other lines for no landing", async () => {
		// The base ticked the box under A and the branch the one under B: the
		// same changed lines, in other places, so the branch's tick is its own.
		const seed = "# Log\n\n## A\n\n- [ ] ship\n\n## B\n\n- [ ] ship\n";
		await seedLog(seed);
		await git(repo, "checkout", "-q", "-b", "topic");
		const tickedB = "# Log\n\n## A\n\n- [ ] ship\n\n## B\n\n- [x] ship\n";
		await commit("log.md", tickedB, "tick b");
		await git(repo, "checkout", "-q", "base");
		const tickedA = "# Log\n\n## A\n\n- [x] ship\n\n## B\n\n- [ ] ship\n";
		await commit("log.md", tickedA, "tick a");
		await commit("log.md", `${tickedA}- [ ] more\n`, "more");
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "halted", conflicted: ["log.md"] });
		expect(outcome).not.toHaveProperty("landed");
		expect(readFileSync(join(repo, "log.md"), "utf8")).toContain("<<<<<<<");
	});

	it("finds a landing in a log marked -diff", async () => {
		// Read as binary, every change to the log prints the same line and no
		// changed one, so the landing is found only when the log is read as text.
		await commit(".gitattributes", "log.md -diff\n", "attributes");
		await seedLog();
		const entry = "# Log\n\n## 1. First\n\nOne.\n";
		await topicWithOneLanded("log.md", entry);
		await commit("log.md", `${entry}\n## 2. Later\n\nTwo.\n`, "later");
		const landed = await landing();
		await git(repo, "checkout", "-q", "topic");

		const outcome = await createGitRebaser({ exec: spawnExec() }).rebase(
			repo,
			"base",
		);

		expect(outcome).toMatchObject({ kind: "replayed", landed: [landed] });
		expect(readFileSync(join(repo, "log.md"), "utf8")).toBe(
			`${entry}\n## 2. Later\n\nTwo.\n`,
		);
	});
});
