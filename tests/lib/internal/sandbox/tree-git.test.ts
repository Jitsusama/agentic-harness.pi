/**
 * Where pi runs git outside the sandbox: only where the git a folder
 * answers to is what its own files agree on, and, for a sandboxed
 * session, a repository the fence keeps read-only.
 */
import {
	chmodSync,
	cpSync,
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
import { spawnExec } from "../../../../lib/core/exec/index.ts";
import {
	type GitRules,
	gitRun,
	guardedExec,
	heldGit,
	refusedIn,
	treeGit,
	within,
	withoutFolders,
} from "../../../../lib/internal/sandbox/tree-git.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";
import {
	LATE_MS,
	type LateWriter,
	lateWriter,
	timed,
} from "../../../support/late-writer.ts";

let home: string;
let trees: string;
let template: string;

beforeEach(async () => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "tree-git-home-")));
	trees = join(home, ".local/state/work/trees");
	mkdirSync(trees, { recursive: true });
	template = await freshRepo("tree-git");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	disposeRepo(template);
});

describe("a path within a folder", () => {
	it("is one not there yet below a linked folder, judged where the link leads", () => {
		// A Mac's /tmp is a link, so a folder not yet made in its caches was
		// judged outside them.
		const folder = join(home, "really");
		mkdirSync(folder);
		const linked = join(home, "linked");
		symlinkSync(folder, linked);
		const missing = join(linked, "not-yet", "deeper");
		expect(within(missing, linked)).toBe(true);
		expect(within(missing, folder)).toBe(true);
		expect(within(join(folder, "not-yet"), linked)).toBe(true);
		expect(within(join(home, "beside", "not-yet"), linked)).toBe(false);
	});

	it("is judged inside a folder not there yet below a linked one", () => {
		const folder = join(home, "really");
		mkdirSync(folder);
		symlinkSync(folder, join(home, "linked"));
		const missing = join(home, "linked", "not-yet");
		expect(within(join(folder, "not-yet", "deeper"), missing)).toBe(true);
		expect(within(join(home, "not-yet", "deeper"), missing)).toBe(false);
	});

	it("climbs from where a link leads, not from how its path is spelled", () => {
		mkdirSync(join(home, "really"));
		mkdirSync(join(home, "two"));
		symlinkSync(join(home, "really"), join(home, "two", "linked"));
		// Built as a string, since join would fold the `..` before within saw it.
		const climbed = `${join(home, "two", "linked")}/../beside`;
		expect(within(climbed, join(home, "two"))).toBe(false);
		expect(within(climbed, home)).toBe(true);
	});

	it("is judged where a link to nothing would make its file", () => {
		const folder = join(home, "really");
		mkdirSync(folder);
		symlinkSync(join(home, "outside", "file"), join(folder, "dangling"));
		expect(within(join(folder, "dangling"), folder)).toBe(false);
		expect(within(join(folder, "dangling"), join(home, "outside"))).toBe(true);
	});

	it("is judged as spelled past where its links loop, in the folder holding it", () => {
		// A check refusing a folder that meets the work must still meet one
		// whose links loop, as a self-linked cache folder would.
		symlinkSync(join(home, "loop"), join(home, "loop"));
		expect(within(join(home, "loop"), home)).toBe(true);
		expect(within(join(home, "loop", "x"), join(home, "loop"))).toBe(true);
		expect(within(home, join(home, "loop"))).toBe(false);
		expect(within(join(home, "loop"), join(home, "beside"))).toBe(false);
	});

	it("is judged past a linked folder above a loop", () => {
		const folder = join(home, "really");
		mkdirSync(folder);
		symlinkSync(folder, join(home, "linked"));
		symlinkSync(join(folder, "loop"), join(folder, "loop"));
		expect(within(join(home, "linked", "loop"), folder)).toBe(true);
	});

	it("keeps a relative path's way out", () => {
		expect(within(join("..", "x"), process.cwd())).toBe(false);
		expect(within("x", process.cwd())).toBe(true);
	});
});

/** What every git pi runs outside the fence is given first. */
const NO_MONITOR = ["-c", "core.fsmonitor=false"];

const rules = (over: Partial<GitRules> = {}): GitRules => ({
	home,
	fenced: false,
	trees,
	...over,
});

/** A copy of the template repository at `where` under the home folder. */
function repository(where: string): string {
	const path = join(home, where);
	mkdirSync(path, { recursive: true });
	cpSync(template, path, { recursive: true });
	return path;
}

/** A worktree of `repo` cut where the work tool cuts them. */
async function tree(repo: string, name: string): Promise<string> {
	const path = join(trees, name);
	await git(repo, "worktree", "add", "-q", "--detach", path);
	return path;
}

describe("git that pi runs outside the sandbox", () => {
	it("names a tree's own git folder and working folder outright", async () => {
		const repo = repository("src/r");
		const cut = await tree(repo, "t");

		expect(gitRun(cut, ["status"], rules())).toEqual({
			args: [
				...NO_MONITOR,
				`--git-dir=${join(repo, ".git/worktrees/t")}`,
				`--work-tree=${cut}`,
				"status",
			],
		});
		const ran = await guardedExec(spawnExec(), () => rules())("git", [
			"-C",
			join(cut),
			"rev-parse",
			"--show-toplevel",
		]);
		expect(ran.stdout.trim(), ran.stderr).toBe(cut);
	});

	it("won't run where a .git file was pointed at a git folder of a command's own", async () => {
		const repo = repository("src/r");
		const cut = await tree(repo, "t");
		// What a fenced command can do: make a git folder it writes, with
		// a program for git to start, and point a tree at it.
		const forged = join(home, ".cache/forged");
		cpSync(join(repo, ".git"), forged, { recursive: true });
		const ran = join(home, "ran");
		const monitor = join(home, "monitor.sh");
		writeFileSync(monitor, `#!/bin/sh\ntouch ${ran}\n`);
		chmodSync(monitor, 0o755);
		writeFileSync(
			join(forged, "config"),
			`[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${monitor}\n`,
		);
		writeFileSync(join(cut, ".git"), `gitdir: ${forged}\n`);

		const answer = await guardedExec(spawnExec(), () => rules())("git", [
			"-C",
			cut,
			"status",
		]);

		expect(answer.code, answer.stderr).toBe(126);
		expect(answer.stderr).toContain("names no worktree");
		expect(existsSync(ran), "the forged monitor never ran").toBe(false);
		expect(refusedIn(cut, rules()), "the tree refused").toBe(cut);
	});

	it("won't run in a cut tree whose repository lies outside the guard, laid out to agree", async () => {
		const repo = repository("src/r");
		const cut = await tree(repo, "t");
		// The whole layout a check of the files alone would take: a
		// repository a command writes, its worktree pointing back.
		const forged = join(home, ".cache/forged");
		cpSync(join(repo, ".git"), forged, { recursive: true });
		const own = join(forged, "worktrees/t");
		writeFileSync(join(own, "gitdir"), `${join(cut, ".git")}\n`);
		writeFileSync(join(own, "commondir"), "../..\n");
		writeFileSync(join(cut, ".git"), `gitdir: ${own}\n`);

		expect(gitRun(cut, ["status"], rules())).toMatchObject({
			top: cut,
			refused: expect.stringContaining(`a worktree of ${forged}`),
		});
	});

	it("won't run where a repository's git folder holds a commondir sending git elsewhere", async () => {
		const repo = repository("src/r");
		// git reads a main repository's commondir too, and takes that
		// folder's settings, whatever the fence keeps read-only here.
		const forged = join(home, ".cache/forged");
		cpSync(join(repo, ".git"), forged, { recursive: true });
		const ran = join(home, "ran");
		const monitor = join(home, "monitor.sh");
		writeFileSync(monitor, `#!/bin/sh\ntouch ${ran}\n`);
		chmodSync(monitor, 0o755);
		writeFileSync(
			join(forged, "config"),
			`[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${monitor}\n`,
		);
		writeFileSync(join(repo, ".git/commondir"), `${forged}\n`);
		const cut = join(trees, "t");
		mkdirSync(join(repo, ".git/worktrees/t"), { recursive: true });
		mkdirSync(cut);
		writeFileSync(join(cut, ".git"), `gitdir: ${repo}/.git/worktrees/t\n`);
		writeFileSync(join(repo, ".git/worktrees/t/gitdir"), `${cut}/.git\n`);
		writeFileSync(join(repo, ".git/worktrees/t/commondir"), "../..\n");

		const answer = await guardedExec(spawnExec(), () => rules())("git", [
			"-C",
			repo,
			"status",
		]);

		expect(answer.code, answer.stderr).toBe(126);
		expect(answer.stderr).toContain("holds a commondir");
		expect(existsSync(ran), "the forged monitor never ran").toBe(false);
		expect(gitRun(cut, ["status"], rules())).toMatchObject({
			top: cut,
			refused: expect.stringContaining("holds a commondir"),
		});
		expect(refusedIn(repo, rules()), "the repository refused").toBe(repo);
	});

	it("won't run in a repository of its own where trees are cut", () => {
		const own = join(trees, "made");
		mkdirSync(own);
		cpSync(template, own, { recursive: true });

		expect(gitRun(own, ["status"], rules())).toMatchObject({
			top: own,
			refused: expect.stringContaining("rather than a worktree"),
		});
	});

	it("won't follow a .git that is a link", () => {
		const folder = join(home, "linked");
		mkdirSync(folder);
		symlinkSync(join(template, ".git"), join(folder, ".git"));

		expect(gitRun(folder, ["status"], rules())).toMatchObject({
			refused: expect.stringContaining("is a link"),
		});
	});

	it("names the repository it refuses, from any folder below it", () => {
		const folder = join(home, "linked");
		mkdirSync(join(folder, "src"), { recursive: true });
		symlinkSync(join(template, ".git"), join(folder, ".git"));

		expect(refusedIn(join(folder, "src"), rules())).toBe(folder);
		expect(refusedIn(template, rules()), "git may run there").toBeUndefined();
	});

	it("holds a sandboxed session to repositories the fence guards", async () => {
		const guarded = repository("src/r");
		const scratch = repository(".cache/quest/clone");
		const scratchTree = await tree(scratch, "s");
		const fenced = rules({ fenced: true });

		expect(gitRun(guarded, ["status"], fenced)).toEqual({
			args: [...NO_MONITOR, "status"],
		});
		expect(
			gitRun(repository("notes"), ["status"], fenced),
			"a repository in another entry of the home folder, which a command can make",
		).toMatchObject({ refused: expect.stringContaining("doesn't keep") });
		expect(gitRun(scratch, ["status"], fenced)).toMatchObject({
			top: scratch,
			refused: expect.stringContaining("doesn't keep read-only"),
		});
		expect(gitRun(scratchTree, ["status"], fenced)).toMatchObject({
			top: scratchTree,
			refused: expect.stringContaining(`a worktree of ${scratch}/.git`),
		});
		expect(
			gitRun(scratch, ["status"], rules()),
			"an unsandboxed session's commands could do anything anyway",
		).toEqual({ args: [...NO_MONITOR, "status"] });
		expect(
			gitRun(scratchTree, ["status"], rules()),
			"a cut tree is held to the guard in every session",
		).toMatchObject({ refused: expect.stringContaining("a worktree of") });
	});

	it("passes what has no repository, or names its git folder, as it is", () => {
		const plain = join(home, "plain");
		mkdirSync(plain);

		expect(gitRun(plain, ["ls-remote", "x"], rules())).toEqual({
			args: [...NO_MONITOR, "ls-remote", "x"],
			unrooted: plain,
		});
		expect(
			gitRun(plain, ["--git-dir=/x", "status"], rules({ fenced: true })),
		).toEqual({ args: [...NO_MONITOR, "--git-dir=/x", "status"] });
	});

	it("carries the folder that held no git, as it really is, from any path to it", () => {
		const plain = join(home, "plain");
		mkdirSync(join(plain, "below"), { recursive: true });
		symlinkSync(plain, join(home, "alias"));

		expect(gitRun(join(home, "alias", "below"), ["status"], rules())).toEqual({
			args: [...NO_MONITOR, "status"],
			unrooted: join(plain, "below"),
		});
	});

	// The queue runs it there, so a link in the path it was given can't
	// be repointed to a repository while it waits.
	it("hands the queue the folder that held no git, and git's words without its folders", () => {
		const plain = join(home, "plain");
		mkdirSync(join(plain, "below"), { recursive: true });
		symlinkSync(plain, join(home, "alias"));
		const asked = ["-C", join(home, "alias"), "-C", "below", "push", "origin"];

		expect(heldGit(() => rules())("git", asked)).toEqual({
			args: [...NO_MONITOR, ...asked],
			unrooted: {
				folder: join(plain, "below"),
				args: [...NO_MONITOR, "push", "origin"],
			},
		});
		expect(withoutFolders(["-c", "a=-C", "-C", "x", "log", "-C"])).toEqual([
			"-c",
			"a=-C",
			"log",
			"-C",
		]);
	});

	// git reads a bare repository's objects from the folder its commondir
	// names, so HEAD and a commondir are a repository with settings of a
	// command's own choosing.
	it("finds a bare repository that names its objects through a commondir", () => {
		const bare = join(home, "bare");
		mkdirSync(join(bare, "below"), { recursive: true });
		writeFileSync(join(bare, "HEAD"), "ref: refs/heads/x\n");
		writeFileSync(join(bare, "commondir"), "/elsewhere\n");

		expect(gitRun(join(bare, "below"), ["status"], rules())).toMatchObject({
			top: bare,
			refused: expect.stringContaining("holds a commondir"),
		});
	});

	it("won't run where trees are cut when the repository it finds lies above them", () => {
		// A home kept as a repository of its own has a tree whose .git was
		// taken away answer to it.
		const above = repository("dots");
		const cutHere = join(above, "trees");
		mkdirSync(join(cutHere, "t"), { recursive: true });

		expect(
			gitRun(join(cutHere, "t"), ["status"], rules({ trees: cutHere })),
		).toMatchObject({
			top: join(cutHere, "t"),
			refused: expect.stringContaining("holds no .git"),
		});
		expect(gitRun(above, ["status"], rules({ trees: cutHere }))).toEqual({
			args: [...NO_MONITOR, "status"],
		});
	});

	// Any session's sandboxed commands can write a cut tree's folder, so
	// one can take its `.git` away while a push waits for the queue and
	// put back one naming a git folder of its own before the push runs.
	it("won't run where trees are cut in a folder holding no .git", async () => {
		const cut = await tree(repository("src/r"), "t");
		rmSync(join(cut, ".git"));
		const ran = await guardedExec(spawnExec(), () => rules())("git", [
			"-C",
			cut,
			"status",
		]);

		expect(gitRun(cut, ["status"], rules())).toMatchObject({
			top: cut,
			refused: expect.stringContaining("holds no .git"),
		});
		expect(ran.code, ran.stderr).toBe(126);
		expect(refusedIn(cut, rules()), "the tree refused").toBe(cut);
		expect(
			refusedIn(join(trees, "never-cut"), rules()),
			"a tree's folder not there yet",
		).toBe(join(trees, "never-cut"));
	});

	// Git takes a bare repository whose HEAD or objects is a link, so a
	// folder shaped so is found, and held to the guard, rather than read
	// as holding no git while pi's git runs its settings.
	it.each(["objects", "HEAD"])(
		"finds a bare repository whose %s is a link",
		(linked) => {
			const bare = join(home, ".cache/bare");
			cpSync(join(template, ".git"), bare, { recursive: true });
			cpSync(join(bare, linked), join(home, ".cache", `real-${linked}`), {
				recursive: true,
			});
			rmSync(join(bare, linked), { recursive: true });
			symlinkSync(join(home, ".cache", `real-${linked}`), join(bare, linked));

			expect(gitRun(bare, ["status"], rules({ fenced: true }))).toMatchObject({
				top: bare,
				refused: expect.stringContaining("doesn't keep read-only"),
			});
			expect(gitRun(bare, ["status"], rules())).toEqual({
				args: [...NO_MONITOR, "status"],
			});
		},
	);
});

// A fenced command chooses what stands at a tree's `.git`, and the guard
// reads it before every git pi runs and in reclaim's survey, so a read
// waiting on a fifo would hold them all. Each writer is late and names
// what a good tree's file would, so a read that waits is slow and finds
// the tree's git.
describe("a tree's git where a fifo stands", () => {
	const writers: LateWriter[] = [];
	afterEach(() => {
		for (const writer of writers.splice(0)) writer.stop();
	});

	/** A tree at `trees/<name>` and its own folder in a repository's git. */
	function layout(name: string): { tree: string; own: string } {
		const repo = join(home, "src", name, ".git");
		const own = join(repo, "worktrees", name);
		const tree = join(trees, name);
		mkdirSync(join(repo, "objects"), { recursive: true });
		mkdirSync(own, { recursive: true });
		mkdirSync(tree);
		return { tree, own };
	}

	it("is none, at once, where the tree's .git is a fifo", () => {
		const { tree, own } = layout("fifo-dot-git");
		writeFileSync(join(own, "gitdir"), `${join(tree, ".git")}\n`);
		writeFileSync(join(own, "commondir"), "../..\n");
		writers.push(lateWriter(join(tree, ".git"), `gitdir: ${own}\n`));

		const read = timed(() => treeGit(tree, "/nowhere-home"));

		expect(read.tookMs, "no read waited").toBeLessThan(LATE_MS / 2);
		expect(read.value).toBeUndefined();
	});

	it("is none, at once, where its way back is a fifo", () => {
		const { tree, own } = layout("fifo-gitdir");
		writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
		writeFileSync(join(own, "commondir"), "../..\n");
		writers.push(lateWriter(join(own, "gitdir"), `${join(tree, ".git")}\n`));

		const read = timed(() => treeGit(tree, "/nowhere-home"));

		expect(read.tookMs, "no read waited").toBeLessThan(LATE_MS / 2);
		expect(read.value).toBeUndefined();
	});

	it("is none, at once, where its commondir is a fifo", () => {
		const { tree, own } = layout("fifo-commondir");
		writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
		writeFileSync(join(own, "gitdir"), `${join(tree, ".git")}\n`);
		writers.push(lateWriter(join(own, "commondir"), "../..\n"));

		const read = timed(() => treeGit(tree, "/nowhere-home"));

		expect(read.tookMs, "no read waited").toBeLessThan(LATE_MS / 2);
		expect(read.value).toBeUndefined();
	});

	it("is the tree's git where every file is plain", () => {
		const { tree, own } = layout("plain");
		writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
		writeFileSync(join(own, "gitdir"), `${join(tree, ".git")}\n`);
		writeFileSync(join(own, "commondir"), "../..\n");

		expect(treeGit(tree, "/nowhere-home")).toEqual({
			gitDir: own,
			common: join(home, "src", "plain", ".git"),
		});
	});
});
