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
import {
	cpSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * Room for a test or hook that drives real git on a busy machine.
 *
 * Each git command is a process, and spawns are what slows most under
 * load: at a load average of 78, 104 of the 290 tests that use this
 * fixture took over a second and three ran past vitest's five, every
 * one of them passing alone. Five seconds there measures the machine,
 * not the code, so a file that imports this fixture gets thirty. It is
 * set here rather than in each file because using real git is what
 * earns it, and a new file using the fixture should not have to learn
 * that by failing.
 */
export const REAL_GIT_MS = 30_000;

vi.setConfig({ testTimeout: REAL_GIT_MS, hookTimeout: REAL_GIT_MS });

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
	// config must not decide whether the suite passes. gpgsign is
	// disabled the same way: a machine with commit signing on by
	// default must not make these commits hang on a signing prompt.
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	await git(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "README.md"), "scratch repo\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-qm", "initial");
	return dir;
}

/**
 * A fresh repo with one commit on `main`, isolated from every other.
 *
 * Its real path, since git names a repo by its real path: where the
 * temp directory sits behind a link (macOS's `/var`, or an agent's
 * `TMPDIR` pointing into its quest's workspace) a test comparing what
 * git said with the path it was handed would otherwise fail.
 *
 * The caller owns the directory and should remove it, which
 * {@link disposeRepo} does.
 */
export async function freshRepo(prefix = "repo"): Promise<string> {
	template ??= buildTemplate();
	const source = await template;
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
	cpSync(source, dir, { recursive: true });
	return realpathSync(dir);
}

/** Remove a repo handed out by {@link freshRepo}. Never throws. */
export function disposeRepo(dir: string | undefined): void {
	if (dir) rmSync(dir, { recursive: true, force: true });
}
