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
