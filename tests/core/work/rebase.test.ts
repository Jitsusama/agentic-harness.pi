/**
 * Replaying a branch onto a new base.
 *
 * The tests are mostly about the halt, because that is the outcome that
 * matters: a rebase that stops leaves the tree neither where it was nor where
 * it was going, and a tool that says only "failed" hands back a repository the
 * caller has to diagnose from nothing.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRebaser } from "../../../lib/core/work/rebase.ts";
import { fakeExec, type Reply } from "../../support/fake-exec.ts";

const TREE = "/trees/topic";

/**
 * Paths standing in for git's rebase state directory.
 *
 * Whether a replay is part-way through is read off the filesystem, not asked of
 * a subprocess: a subprocess runs in pi's own working directory while git
 * reports that path relative to the tree, so the old probe answered "not
 * rebasing" for a tree that was mid-rebase. The fake therefore hands back a
 * path that really exists, or one that really does not.
 */
const PRESENT = tmpdir();
const ABSENT = join(tmpdir(), "no-such-rebase-state-directory");

/**
 * The bases git knows here, each answering as its own name for its commit,
 * so a call naming one reads as it did when bases went to git by name.
 * Matched with the flag before it, since `main^{commit}` alone would
 * match `refs/remotes/origin/main^{commit}` too.
 */
const known: Reply[] = ["main", "base"].map((name) => ({
	when: [`--quiet ${name}^{commit}`],
	stdout: `${name}\n`,
}));

/** Not mid-rebase: neither state directory is there. */
const settled: Reply[] = [
	{ when: ["rev-parse", "--git-path"], stdout: `${ABSENT}\n` },
	...known,
];

/** Mid-rebase: the state directory exists. */
const midway: Reply[] = [
	{ when: ["rev-parse", "--git-path"], stdout: `${PRESENT}\n` },
];

/** On `topic`, clean, three commits above the base. */
const ready: Reply[] = [
	...settled,
	{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
	{ when: ["status", "--porcelain"], stdout: "" },
	{ when: ["rev-list", "--count"], stdout: "3\n" },
];

describe("replaying a branch", () => {
	it("reports what it replayed and onto what", async () => {
		const { exec } = fakeExec([
			...ready,
			{ when: ["rebase", "main"], code: 0 },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

		expect(outcome).toMatchObject({
			kind: "replayed",
			branch: "topic",
			onto: "main",
			commits: 3,
		});
	});

	it("asks git to reapply cherry-picks rather than match the base's patches", async () => {
		// On 21 November a World rebase of two commits read 83 GB over 16
		// minutes before it started, matching patches against every commit
		// main had gained. With this flag it reached its first pick in
		// seconds; what then becomes of a landed commit is in rebase-live.
		const { exec, calls } = fakeExec([
			...ready,
			{ when: ["rebase", "main"], code: 0 },
		]);

		await createGitRebaser({ exec }).rebase(TREE, "main");

		const replay = calls.find((call) => call.args.includes("rebase"));
		expect(replay?.args).toContain("--reapply-cherry-picks");
	});

	it("says nothing needed replaying rather than replaying nothing", async () => {
		const { exec } = fakeExec([
			...settled,
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			{ when: ["status", "--porcelain"], stdout: "" },
			{ when: ["rev-list", "--count"], stdout: "0\n" },
			{ when: ["merge-base", "--is-ancestor", "main", "HEAD"], code: 0 },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

		expect(outcome).toMatchObject({ kind: "already-there" });
	});

	it("moves a branch with nothing of its own up to a base that moved on", async () => {
		// A branch just cut from main, asked onto a branch built on main: it
		// holds no commit the base lacks, but the base holds ones it lacks, so
		// it is not there yet.
		const { exec, calls } = fakeExec([
			...settled,
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			{ when: ["status", "--porcelain"], stdout: "" },
			{ when: ["rev-list", "--count"], stdout: "0\n" },
			{ when: ["merge-base", "--is-ancestor", "base", "HEAD"], code: 1 },
			{ when: ["rebase", "base"], code: 0 },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "base");

		expect(calls.map((one) => one.args)).toContainEqual(
			expect.arrayContaining(["rebase"]),
		);
		expect(outcome).toMatchObject({
			kind: "replayed",
			branch: "topic",
			onto: "base",
			commits: 0,
		});
	});

	it("scopes every call to the tree", async () => {
		const { exec, calls } = fakeExec([
			...ready,
			{ when: ["rebase", "main"], code: 0 },
		]);

		await createGitRebaser({ exec }).rebase(TREE, "main");

		for (const call of calls.filter((one) => one.command === "git")) {
			// Scoping is what matters, not its position: global flags may precede
			// it, and pinning the index made this test fail when the editor was
			// turned off rather than when the scoping broke.
			const at = call.args.indexOf("-C");
			expect(at).toBeGreaterThanOrEqual(0);
			expect(call.args[at + 1]).toBe(TREE);
		}
	});

	it("tells git there is no editor to open", async () => {
		// A replay that conflicts is continued with `git commit -e`, which opens
		// an editor on a stdin nobody is attached to and never returns. The live
		// test proves the behaviour by conflicting for real; this one pins the
		// argument, because the live one takes seconds and this takes none.
		const { exec, calls } = fakeExec([
			...ready,
			{ when: ["rebase", "main"], code: 0 },
		]);

		await createGitRebaser({ exec }).rebase(TREE, "main");

		const replay = calls.find((one) => one.args.includes("rebase"));
		expect(replay?.args).toContain("core.editor=true");
	});
});

describe("refusing to replay", () => {
	it("refuses over uncommitted work, and shows it", async () => {
		// Git's own autostash would hide this rather than state it, and moving
		// somebody's uncommitted changes is not a decision to take quietly.
		const { exec } = fakeExec([
			...settled,
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			{ when: ["status", "--porcelain"], stdout: " M lib/work/tree.ts\n" },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

		expect(outcome).toMatchObject({ kind: "refused" });
		expect(outcome).toHaveProperty(
			"reason",
			expect.stringContaining("lib/work/tree.ts"),
		);
	});

	it("refuses to start a second replay over a halted one, naming both ways out", async () => {
		const { exec } = fakeExec(midway);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

		expect(outcome).toHaveProperty("reason", expect.stringMatching(/resume/i));
		expect(outcome).toHaveProperty("reason", expect.stringMatching(/abandon/i));
	});
});

describe("halting on a conflict", () => {
	it("names the paths that disagree", async () => {
		const { exec } = fakeExec([
			...ready,
			{ when: ["rebase", "main"], code: 1 },
			{
				when: ["--diff-filter=U"],
				stdout: "lib/work/tree.ts\nlib/work/broker.ts\n",
			},
			{ when: ["rev-parse", "--short", "REBASE_HEAD"], stdout: "abc1234\n" },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["lib/work/tree.ts", "lib/work/broker.ts"],
			at: "abc1234",
		});
	});

	it("does not claim a halt when the failure was something else", async () => {
		// A failure with nothing unmerged is a refusal, not a halt, and calling
		// it a halt would send a caller looking for conflicts that do not exist.
		const { exec } = fakeExec([
			...ready,
			{
				when: ["rebase", "main"],
				code: 128,
				stderr: "fatal: could not read the index\n",
			},
			{ when: ["--diff-filter=U"], stdout: "" },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

		expect(outcome, "git's failure was read as a halt").toMatchObject({
			kind: "refused",
		});
		expect(outcome, "git's own words were lost").toHaveProperty(
			"reason",
			expect.stringContaining("could not read the index"),
		);
	});

	it("names a base git doesn't know, before asking anything of trunk", async () => {
		// A mistyped base once read as git being unable to judge trunk, which
		// sent the reader after a trunk problem that wasn't there.
		const { exec, calls } = fakeExec(ready);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "nope");

		expect(outcome, "the missing base wasn't named").toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("nope isn't a commit git knows"),
		});
		expect(
			calls.some((call) => call.args.includes("rebase")),
			"git was asked to replay onto a base it doesn't know",
		).toBe(false);
	});

	it("hands git no word opening with a dash", async () => {
		// rebase's --exec runs a shell command after each commit it replays,
		// so the word must reach no git call at all, not only no rebase.
		for (const onto of ["--exec=true", "-x", "--onto=main"]) {
			const { exec, calls } = fakeExec(ready);

			const outcome = await createGitRebaser({ exec }).rebase(TREE, onto);

			expect(outcome, `${onto} wasn't refused`).toMatchObject({
				kind: "refused",
			});
			expect(
				calls.filter((call) => call.args.some((arg) => arg.includes(onto))),
				`git was handed ${onto}`,
			).toEqual([]);
		}
	});
});

/**
 * A checkout whose remote trunk is commit t1, with topic holding 3
 * commits main lacks, 1 of them its own above trunk, meeting main at b1.
 */
const onTrunk: Reply[] = [
	{ when: ["symbolic-ref"], code: 1 },
	{ when: ["--quiet refs/remotes/origin/main^{commit}"], stdout: "t1\n" },
	{ when: ["--no-merges", "HEAD", "^main", "^t1"], stdout: "1\n" },
	{ when: ["--no-merges", "HEAD", "^main"], stdout: "3\n" },
	{ when: ["merge-base", "--all"], stdout: "b1\n" },
	{ when: ["--is-ancestor", "b1", "t1"], code: 0 },
];

describe("judging a replay by trunk", () => {
	it("replays from trunk's commit, onto the base's, once trunk is freshened", async () => {
		const freshened: string[] = [];
		const { exec, calls } = fakeExec([
			...onTrunk,
			...ready,
			{ when: ["rebase"], code: 0 },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main", {
			freshenTrunk: async (trunk) => {
				freshened.push(trunk);
			},
		});

		expect(outcome, "the cut wasn't said").toMatchObject({
			kind: "replayed",
			commits: 1,
			trunk: { name: "origin/main", left: 2 },
		});
		expect(freshened, "trunk wasn't fetched before it was judged").toEqual([
			"refs/remotes/origin/main",
		]);
		const replay = calls.find((call) => call.args.includes("rebase"));
		expect(
			replay?.args.slice(-3),
			"trunk was replayed from by a name another fetch could move",
		).toEqual(["--onto", "main", "t1"]);
	});

	it("fetches no trunk for a branch already on its base", async () => {
		const freshened: string[] = [];
		const { exec } = fakeExec([
			...onTrunk,
			{ when: ["merge-base", "--is-ancestor", "main", "HEAD"], code: 0 },
			...ready,
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main", {
			freshenTrunk: async (trunk) => {
				freshened.push(trunk);
			},
		});

		expect(outcome, "a held base was replayed onto").toMatchObject({
			kind: "already-there",
		});
		expect(freshened, "trunk was fetched for nothing").toEqual([]);
	});

	it.each([
		[
			"a count",
			{ when: ["--count", "--no-merges"], code: 128 },
			"which of topic's commits are origin/main's",
		],
		[
			"where they meet",
			{ when: ["merge-base", "--all"], code: 128 },
			"where topic and main meet",
		],
		[
			"whether a meeting is trunk's",
			{ when: ["--is-ancestor", "b1", "t1"], code: 128 },
			"whether main's history is origin/main's",
		],
	])(
		"refuses, replaying nothing, when git can't give %s",
		async (_, failing, what) => {
			// Falling back to a plain replay here is the very carry of trunk's
			// commits that judging by trunk exists to stop.
			const { exec, calls } = fakeExec([
				failing,
				...onTrunk,
				...ready,
				{ when: ["rebase"], code: 0 },
			]);

			const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

			expect(outcome, "git's silence wasn't said").toMatchObject({
				kind: "refused",
				reason: expect.stringContaining(`git couldn't say ${what}`),
			});
			expect(
				calls.some((call) => call.args.includes("rebase")),
				"it replayed anyway",
			).toBe(false);
		},
	);
});

describe("ending a halted replay", () => {
	it("will not carry on while paths still disagree", async () => {
		const { exec } = fakeExec([
			...midway,
			{ when: ["--diff-filter=U"], stdout: "lib/work/tree.ts\n" },
		]);

		const outcome = await createGitRebaser({ exec }).resume(TREE);

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["lib/work/tree.ts"],
		});
	});

	it("carries on once nothing disagrees", async () => {
		const { exec } = fakeExec([
			...midway,
			{ when: ["--diff-filter=U"], stdout: "" },
			{ when: ["rebase", "--continue"], code: 0 },
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
		]);

		const outcome = await createGitRebaser({ exec }).resume(TREE);

		expect(outcome).toMatchObject({ kind: "replayed", branch: "topic" });
	});

	it("puts the tree back when asked to abandon", async () => {
		const { exec } = fakeExec([
			...midway,
			{ when: ["rebase", "--abort"], code: 0 },
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
		]);

		const outcome = await createGitRebaser({ exec }).abandon(TREE);

		expect(outcome).toMatchObject({ kind: "abandoned", branch: "topic" });
	});

	it("refuses to resume or abandon what is not halted", async () => {
		const rebaser = () => createGitRebaser({ exec: fakeExec(settled).exec });

		expect(await rebaser().resume(TREE)).toMatchObject({ kind: "refused" });
		expect(await rebaser().abandon(TREE)).toMatchObject({ kind: "refused" });
	});
});
