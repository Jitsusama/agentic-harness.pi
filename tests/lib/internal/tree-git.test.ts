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
			refused: expect.stringContaining("holds a commondir"),
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

		expect(gitRun(guarded, ["status"], fenced)).toEqual({
			args: [...NO_MONITOR, "status"],
		});
		expect(
			gitRun(repository("notes"), ["status"], fenced),
			"a repository in another entry of the home folder, which a command can make",
		).toMatchObject({ refused: expect.stringContaining("doesn't keep") });
		expect(gitRun(scratch, ["status"], fenced)).toMatchObject({
			refused: expect.stringContaining("doesn't keep read-only"),
		});
		expect(gitRun(scratchTree, ["status"], fenced)).toMatchObject({
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
		});
		expect(
			gitRun(plain, ["--git-dir=/x", "status"], rules({ fenced: true })),
		).toEqual({ args: [...NO_MONITOR, "--git-dir=/x", "status"] });
	});
});
