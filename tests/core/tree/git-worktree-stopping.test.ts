/**
 * Cutting or pruning a tree can be stopped, and cannot wait for good.
 *
 * `git worktree add` runs the repo's checkout hooks, and a hook that
 * waits on the network (git-lfs is the common one) held `tree-add`
 * with no clock and no way to stop it. The hang here is a hook that
 * records its pid and sleeps, which is what such a hook looks like
 * from outside.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitWorktreeProvider } from "../../../lib/core/internal/tree/providers/git-worktree.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let repoRoot: string;
let scratch: string;

beforeEach(async () => {
	repoRoot = await freshRepo("tree-stop");
	scratch = mkdtempSync(join(tmpdir(), "tree-stop-"));
});

afterEach(() => {
	disposeRepo(repoRoot);
	rmSync(scratch, { recursive: true, force: true });
});

/** A checkout hook that writes its pid where the test can find it, then hangs. */
function hangingCheckoutHook(): string {
	const pidFile = join(scratch, "hook.pid");
	const hook = join(repoRoot, ".git", "hooks", "post-checkout");
	writeFileSync(hook, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
	chmodSync(hook, 0o755);
	return pidFile;
}

/** Whether a process is still there. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: nothing by that number any more.
		return false;
	}
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > ms) throw new Error("never happened");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** How the work settled, or that it was still running after `ms`. */
function outcome(work: Promise<unknown>, ms = 5_000): Promise<string> {
	return Promise.race([
		work.then(
			() => "finished",
			(error: Error) => `${error.name}: ${error.message}`,
		),
		new Promise<string>((r) => setTimeout(() => r("still running"), ms)),
	]);
}

async function branchExists(name: string): Promise<boolean> {
	return (await git(repoRoot, "branch", "--list", name)).trim() !== "";
}

describe("git-worktree provider, stopped or out of time", () => {
	it("stops cutting a tree when told to, taking a hung hook with it and leaving nothing behind", async () => {
		const pidFile = hangingCheckoutHook();
		const provider = createGitWorktreeProvider();
		const stop = new AbortController();
		const creating = provider.create({
			name: "stuck",
			repoRoot,
			signal: stop.signal,
		});
		await until(() => existsSync(pidFile));
		const hook = Number(readFileSync(pidFile, "utf8"));

		const started = Date.now();
		stop.abort();
		expect(await outcome(creating)).toMatch(/^AbortError/);
		expect(Date.now() - started).toBeLessThan(3_000);

		await until(() => !alive(hook), 3_000);
		expect(existsSync(join(repoRoot, ".worktrees", "stuck"))).toBe(false);
		expect(await branchExists("stuck")).toBe(false);
	}, 20_000);

	it("gives up on a tree that takes longer than its clock, leaving nothing behind", async () => {
		hangingCheckoutHook();
		const provider = createGitWorktreeProvider(undefined, { wallMs: 1_000 });
		const started = Date.now();
		expect(await outcome(provider.create({ name: "slow", repoRoot }))).toMatch(
			/^TimeoutError/,
		);
		expect(Date.now() - started).toBeLessThan(4_000);
		expect(existsSync(join(repoRoot, ".worktrees", "slow"))).toBe(false);
		expect(await branchExists("slow")).toBe(false);
	}, 20_000);

	it("cuts nothing once already stopped", async () => {
		const pidFile = hangingCheckoutHook();
		const provider = createGitWorktreeProvider();
		const stop = new AbortController();
		stop.abort();
		expect(
			await outcome(
				provider.create({ name: "never", repoRoot, signal: stop.signal }),
			),
		).toMatch(/^AbortError/);
		expect(existsSync(pidFile)).toBe(false);
		expect(existsSync(join(repoRoot, ".worktrees", "never"))).toBe(false);
	}, 20_000);

	it("stops a prune when told to, leaving the tree where it was", async () => {
		const provider = createGitWorktreeProvider();
		const handle = await provider.create({ name: "kept", repoRoot });

		// From here on every git this process starts hangs.
		const bin = join(scratch, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
		chmodSync(join(bin, "git"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		try {
			const stop = new AbortController();
			const pruning = provider.release({
				path: handle.path,
				signal: stop.signal,
			});
			setTimeout(() => stop.abort(), 300);
			const started = Date.now();
			expect(await outcome(pruning)).toMatch(/^AbortError/);
			expect(Date.now() - started).toBeLessThan(3_000);
		} finally {
			process.env.PATH = path;
		}
		expect(existsSync(handle.path)).toBe(true);
	}, 20_000);
});
