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
import { spawnExec } from "../../../lib/core/exec/index.ts";
import { gitFolders, guardsGitFolder } from "../../../lib/internal/fence.ts";
import {
	type GitRules,
	gitRun,
	guardedExec,
} from "../../../lib/internal/tree-git.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

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
			refused: expect.stringContaining(`a worktree of ${forged}`),
		});
	});

	it("won't run in a repository of its own where trees are cut", () => {
		const own = join(trees, "made");
		mkdirSync(own);
		cpSync(template, own, { recursive: true });

		expect(gitRun(own, ["status"], rules())).toMatchObject({
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

	it("holds a sandboxed session to repositories the fence guards", async () => {
		const guarded = repository("src/r");
		const scratch = repository(".cache/quest/clone");
		const scratchTree = await tree(scratch, "s");
		const fenced = rules({ fenced: true });

		expect(gitRun(guarded, ["status"], fenced)).toEqual({ args: ["status"] });
		expect(gitRun(scratch, ["status"], fenced)).toMatchObject({
			refused: expect.stringContaining("doesn't keep read-only"),
		});
		expect(gitRun(scratchTree, ["status"], fenced)).toMatchObject({
			refused: expect.stringContaining(`a worktree of ${scratch}/.git`),
		});
		expect(
			gitRun(scratch, ["status"], rules()),
			"an unsandboxed session's commands could do anything anyway",
		).toEqual({ args: ["status"] });
		expect(
			gitRun(scratchTree, ["status"], rules()),
			"a cut tree is held to the guard in every session",
		).toMatchObject({ refused: expect.stringContaining("a worktree of") });
	});

	it("passes what has no repository, or names its git folder, as it is", () => {
		const plain = join(home, "plain");
		mkdirSync(plain);

		expect(gitRun(plain, ["ls-remote", "x"], rules())).toEqual({
			args: ["ls-remote", "x"],
		});
		expect(
			gitRun(plain, ["--git-dir=/x", "status"], rules({ fenced: true })),
		).toEqual({ args: ["--git-dir=/x", "status"] });
	});
});

describe("the fence's guarded git folders", () => {
	it("are told apart one at a time as the walk would list them", () => {
		for (const where of [
			"top",
			".hidden-top",
			"src/a",
			"src/github.com/org/repo",
			"src/w/x/y/z",
			"src/v/w/x/y/z",
			"src/.hidden/r",
			"src/a/inner",
			"world/r",
			"world/r2/deeper",
			"elsewhere/r",
		]) {
			mkdirSync(join(home, where, ".git"), { recursive: true });
		}
		const bare = join(home, "src/bare.git");
		mkdirSync(join(bare, "objects"), { recursive: true });
		writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");

		const listed = new Set(gitFolders(home));
		const candidates = [
			...[
				"top",
				".hidden-top",
				"src/a",
				"src/github.com/org/repo",
				"src/w/x/y/z",
				"src/v/w/x/y/z",
				"src/.hidden/r",
				"src/a/inner",
				"world/r",
				"world/r2/deeper",
				"elsewhere/r",
			].map((where) => join(home, where, ".git")),
			bare,
		];
		for (const git of candidates) {
			expect(guardsGitFolder(git, home), git).toBe(listed.has(git));
		}
		expect(listed.size, "the walk found some and missed some").toBeLessThan(
			candidates.length,
		);
		expect([...listed]).toContain(join(home, "src/a/.git"));
	});
});
