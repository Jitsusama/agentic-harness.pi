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
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { gitMovedAt } from "../../../lib/core/work/in-use.ts";
import {
	forgetGoneEntry,
	LOCK_STALE_MS,
} from "../../../lib/core/work/stranded.ts";
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
		expect(read.value, "none was forgotten").toBe(false);
		expect(existsSync(own), "the entry stays").toBe(true);
	});

	it("forgets no entry whose lock is a link, however old", () => {
		// Git writes its lock as a plain file, so a link is somebody's own
		// and kept, though the file it leads to says a cut's word.
		const { repo, own } = layout("recut-link");
		const gone = join(root, "trees", "gone-link");
		writeFileSync(join(own, "gitdir"), `${join(gone, ".git")}\n`);
		writeFileSync(join(root, "cut-word"), "initializing\n");
		symlinkSync(join(root, "cut-word"), join(own, "locked"));

		const later = Date.now() + 2 * LOCK_STALE_MS;

		expect(forgetGoneEntry(repo, gone, later), "none was forgotten").toBe(
			false,
		);
		expect(existsSync(own), "the entry stays").toBe(true);
	});

	it("keeps every entry naming a gone tree while one is locked, else forgets all", () => {
		// Forgetting the unlocked one alone would let a cut go over a tree
		// somebody locked, and forgetting only one would leave git a second.
		const { repo, own } = layout("recut-two");
		const other = join(repo, "worktrees", "recut-two-1");
		mkdirSync(other, { recursive: true });
		const gone = join(root, "trees", "gone-two");
		for (const entry of [own, other]) {
			writeFileSync(join(entry, "gitdir"), `${join(gone, ".git")}\n`);
		}
		writeFileSync(join(other, "locked"), "on a drive\n");

		expect(forgetGoneEntry(repo, gone), "kept while one is locked").toBe(false);
		expect([existsSync(own), existsSync(other)]).toEqual([true, true]);

		rmSync(join(other, "locked"));

		expect(forgetGoneEntry(repo, gone), "forgotten once none is").toBe(true);
		expect([existsSync(own), existsSync(other)]).toEqual([false, false]);
	});
});
