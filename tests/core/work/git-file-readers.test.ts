/**
 * The work tool's readers of a tree's git files never wait on a fifo.
 *
 * Whatever ran in a tree chooses what stands at its `.git`, and so at
 * every git file that names. The in-use check, the orphan check, the
 * branch sweep and a re-cut's cleanup each read such a file, and a read
 * waiting on a fifo's writer would hold the work tool for good. Each
 * writer here is late and says what a good tree's file would, so a read
 * that waits is slow and finds what the plain file would have given.
 * The guard's own reads are held in tree-git.test.ts and reclaim's in
 * stranded.test.ts.
 */
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { gitMovedAt } from "../../../lib/core/work/in-use.ts";
import { forgetGoneEntry } from "../../../lib/core/work/stranded.ts";
import { dropSettledBranches } from "../../../lib/core/work/sweep-branches.ts";
import { goneGitDir } from "../../../lib/core/work/sweep-orphan.ts";
import {
	LATE_MS,
	type LateWriter,
	lateWriter,
	timed,
} from "../../support/late-writer.ts";

let root = "";
const writers: LateWriter[] = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "git-file-readers-")));
});

afterEach(() => {
	for (const writer of writers.splice(0)) writer.stop();
	rmSync(root, { recursive: true, force: true });
});

/** A repository's git folder, and a tree's own folder within it. */
function layout(name: string): { repo: string; own: string; tree: string } {
	const repo = join(root, "src", name, ".git");
	const own = join(repo, "worktrees", name);
	const tree = join(root, "trees", name);
	mkdirSync(own, { recursive: true });
	mkdirSync(tree, { recursive: true });
	return { repo, own, tree };
}

/** A held git worktree at `path`. */
function held(path: string): HeldTree {
	return {
		identity: { key: "worktree-fifo", shareable: false },
		path,
		providerId: "git-worktree",
	};
}

/** An exec that fails every command, keeping each it was asked. */
function failingExec(): { exec: Exec; asked: string[][] } {
	const asked: string[][] = [];
	return {
		exec: (command, args) => {
			asked.push([command, ...args]);
			return Promise.resolve({ code: 1, stdout: "", stderr: "" });
		},
		asked,
	};
}

describe("the in-use check", () => {
	it("reads no git from a fifo at a tree's .git, at once", () => {
		// A read that waits finds the tree's git, whose HEAD moved just now.
		const { own, tree } = layout("in-use");
		writeFileSync(join(own, "HEAD"), "ref: refs/heads/main\n");
		writers.push(lateWriter(join(tree, ".git"), `gitdir: ${own}\n`));

		const read = timed(() => gitMovedAt(tree));

		expect(read.tookMs, "no read waited").toBeLessThan(LATE_MS / 2);
		expect(read.value, "no git to say when it moved").toBe(0);
	});
});

describe("the orphan check", () => {
	it("reads no gone repository from a fifo at a tree's .git, at once", () => {
		// A read that waits finds a git folder that isn't there.
		const { tree } = layout("orphan");
		writers.push(
			lateWriter(join(tree, ".git"), `gitdir: ${join(root, "gone")}\n`),
		);

		const read = timed(() => goneGitDir(tree));

		expect(read.tookMs, "no read waited").toBeLessThan(LATE_MS / 2);
		expect(read.value, "no worktree of a lost clone").toBeUndefined();
	});
});

describe("the branch sweep", () => {
	it("asks git for the checkout of a tree whose .git is a fifo, at once", async () => {
		// A read that waits names the checkout without asking git.
		const { own, tree } = layout("branches-dot-git");
		writeFileSync(join(own, "commondir"), "../..\n");
		writers.push(lateWriter(join(tree, ".git"), `gitdir: ${own}\n`));
		const { exec, asked } = failingExec();

		const started = performance.now();
		await dropSettledBranches({ exec }, [], [held(tree)], 0, {
			branches: [],
		});

		expect(performance.now() - started, "no read waited").toBeLessThan(
			LATE_MS / 2,
		);
		expect(asked[0], "git was asked instead").toContain(tree);
	});

	it("asks git for the checkout of a tree whose commondir is a fifo, at once", async () => {
		const { own, tree } = layout("branches-commondir");
		writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
		writers.push(lateWriter(join(own, "commondir"), "../..\n"));
		const { exec, asked } = failingExec();

		const started = performance.now();
		await dropSettledBranches({ exec }, [], [held(tree)], 0, {
			branches: [],
		});

		expect(performance.now() - started, "no read waited").toBeLessThan(
			LATE_MS / 2,
		);
		expect(asked[0], "git was asked instead").toContain(tree);
	});
});

describe("a re-cut's cleanup", () => {
	it("forgets no entry whose way back is a fifo, at once", () => {
		// A read that waits finds the entry names the gone tree, and forgets it.
		const { repo, own } = layout("recut");
		const gone = join(root, "trees", "gone");
		writers.push(lateWriter(join(own, "gitdir"), `${join(gone, ".git")}\n`));

		const read = timed(() => forgetGoneEntry(repo, gone));

		expect(read.tookMs, "no read waited").toBeLessThan(LATE_MS / 2);
		expect(read.value, "the entry stays").toBe(false);
	});
});
