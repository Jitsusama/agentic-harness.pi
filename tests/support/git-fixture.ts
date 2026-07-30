/**
 * A throwaway git repo per test, without paying for one.
 *
 * Building a repo takes five git subprocesses (init, two configs, add,
 * commit), and a `beforeEach` that does it pays that per test: two
 * files here spent about fifteen seconds on roughly a hundred and
 * fifteen process spawns. Spawns are also the thing that degrades
 * worst when the machine is busy, so this was both the slowest part
 * of those files and the part whose timing depended most on what else
 * was running.
 *
 * So build one pristine repo per process and copy it. A directory
 * copy of a repo this size is a few milliseconds and, more to the
 * point, spawns nothing. The template is memoized for the life of the
 * worker, so a file with twelve tests pays for one repo rather than
 * twelve, and a second file in the same worker pays for none.
 *
 * Copying rather than sharing keeps the isolation a `beforeEach` was
 * there to provide: every test still gets a repo nobody else has
 * touched, and may commit to it, branch it or add worktrees to it.
 */

import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run git in a directory, returning stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
}

/** The memoized template, built at most once per worker. */
let template: Promise<string> | undefined;

async function buildTemplate(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "git-fixture-template-"));
	await git(dir, "init", "-q", "-b", "main");
	// Committing needs an identity, and a developer's own global
	// config must not decide whether the suite passes.
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	writeFileSync(join(dir, "README.md"), "scratch repo\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-qm", "initial");
	return dir;
}

/**
 * A fresh repo with one commit on `main`, isolated from every other.
 *
 * The caller owns the directory and should remove it, which
 * {@link disposeRepo} does.
 */
export async function freshRepo(prefix = "repo"): Promise<string> {
	template ??= buildTemplate();
	const source = await template;
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
	cpSync(source, dir, { recursive: true });
	return dir;
}

/** Remove a repo handed out by {@link freshRepo}. Never throws. */
export function disposeRepo(dir: string | undefined): void {
	if (dir) rmSync(dir, { recursive: true, force: true });
}
