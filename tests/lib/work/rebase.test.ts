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
import { createGitRebaser } from "../../../lib/work/rebase.js";
import { fakeExec, type Reply } from "../review/support/fake-exec.js";

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

/** Not mid-rebase: neither state directory is there. */
const settled: Reply[] = [
	{ when: ["rev-parse", "--git-path"], stdout: `${ABSENT}\n` },
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

	it("says nothing needed replaying rather than replaying nothing", async () => {
		const { exec } = fakeExec([
			...settled,
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			{ when: ["status", "--porcelain"], stdout: "" },
			{ when: ["rev-list", "--count"], stdout: "0\n" },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "main");

		expect(outcome).toMatchObject({ kind: "already-there" });
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
		// An unknown base is a refusal, not a halt, and calling it a halt would
		// send a caller looking for conflicts that do not exist.
		const { exec } = fakeExec([
			...ready,
			{
				when: ["rebase", "nope"],
				code: 128,
				stderr: "invalid upstream 'nope'\n",
			},
			{ when: ["--diff-filter=U"], stdout: "" },
		]);

		const outcome = await createGitRebaser({ exec }).rebase(TREE, "nope");

		expect(outcome).toMatchObject({ kind: "refused" });
		expect(outcome).toHaveProperty(
			"reason",
			expect.stringContaining("invalid upstream"),
		);
	});
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
