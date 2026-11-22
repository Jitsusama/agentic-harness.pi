/**
 * The work tool's readers of a tree's git files never wait on a fifo.
 *
 * Whatever ran in a tree chooses what stands at its `.git`, and so at
 * every git file that names. The in-use check, the orphan check, the
 * branch sweep, a re-cut's cleanup and a replay's notes each read such
 * a file, and a read waiting on a fifo's writer would hold the work tool
 * for good. Each writer here is late and says what a good tree's file
 * would, so a read that waits is slow and finds what the plain file
 * would have given. A replay writes its notes there too, and each late
 * reader here holds a write that waits on its open just as long.
 * The guard's own reads are held in tree-git.test.ts and reclaim's in
 * stranded.test.ts.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
import { createGitRebaser, recordOnto } from "../../../lib/core/work/rebase.ts";
import {
	forgetGoneEntry,
	LOCK_STALE_MS,
} from "../../../lib/core/work/stranded.ts";
import { dropSettledBranches } from "../../../lib/core/work/sweep-branches.ts";
import { goneGitDir } from "../../../lib/core/work/sweep-orphan.ts";
import {
	LATE_MS,
	type LateWriter,
	lateReader,
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

/**
 * An exec that answers where a replay keeps its notes, `first` the
 * first `firstAsks` times and `later` after, says `conflicted` is
 * unmerged, and fails every other command.
 */
function replayExec(
	first: string,
	later: string,
	firstAsks: number,
	conflicted: string,
): Exec {
	let asks = 0;
	return (_command, args) => {
		const said = (stdout: string) =>
			Promise.resolve({ code: 0, stdout: `${stdout}\n`, stderr: "" });
		const at = args.indexOf("--git-path");
		const what = at < 0 ? undefined : args[at + 1];
		if (what === "rebase-merge") {
			asks += 1;
			return said(asks <= firstAsks ? first : later);
		}
		if (what?.startsWith("rebase-merge/")) {
			return said(join(first, what.slice("rebase-merge/".length)));
		}
		if (args.includes("--diff-filter=U")) return said(conflicted);
		return Promise.resolve({ code: 1, stdout: "", stderr: "" });
	};
}

describe("a replay's notes", () => {
	it("reads none from a fifo and writes none into one, at once", async () => {
		// The resume asks twice before its first note is read, and a
		// third time where it writes the moves note back.
		const first = join(root, "rebase-merge");
		const later = join(root, "rebase-merge-later");
		mkdirSync(first);
		mkdirSync(later);
		writeFileSync(
			join(first, "agentic-harness-moves.json"),
			JSON.stringify([{ path: "LOG.md", prefix: "#", from: 1, to: 2 }]),
		);
		for (const [name, words] of [
			["onto", "0123456789abcdef\n"],
			["head-name", "refs/heads/feature\n"],
			["agentic-harness-onto", "main\n"],
		] as const) {
			writers.push(lateWriter(join(first, name), words));
		}
		writers.push(lateReader(join(later, "agentic-harness-moves.json")));
		const rebaser = createGitRebaser({
			exec: replayExec(first, later, 2, "LOG.md"),
		});

		const started = performance.now();
		const halt = await rebaser.resume(join(root, "tree"));

		expect(performance.now() - started, "nothing waited").toBeLessThan(
			LATE_MS / 2,
		);
		expect(halt, "halted, no fifo read for its names").toEqual({
			kind: "halted",
			conflicted: ["LOG.md"],
		});
	});

	it("writes no onto name into a fifo, at once", async () => {
		const directory = join(root, "rebase-merge");
		mkdirSync(directory);
		writers.push(lateReader(join(directory, "agentic-harness-onto")));

		const started = performance.now();
		await recordOnto(
			replayExec(directory, directory, 1, ""),
			join(root, "tree"),
			"main",
		);

		expect(performance.now() - started, "no write waited").toBeLessThan(
			LATE_MS / 2,
		);
	});

	it("still writes the onto name into a plain file", async () => {
		const directory = join(root, "rebase-merge");
		mkdirSync(directory);
		writeFileSync(
			join(directory, "agentic-harness-onto"),
			"a much longer name\n",
		);

		await recordOnto(
			replayExec(directory, directory, 1, ""),
			join(root, "tree"),
			"main",
		);

		expect(
			readFileSync(join(directory, "agentic-harness-onto"), "utf8"),
			"the whole note, cut to the new name",
		).toBe("main\n");
	});
});

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
