/**
 * Tests for the fix-worktree provisioner.
 *
 * Fix worktrees differ from council worktrees: they're
 * keyed by PR number (stable across fixup commits), have
 * the PR branch checked out (so `git commit` and `git
 * push` do the obvious thing) and live under
 * `fix-worktrees/` rather than `worktrees/`.
 *
 * These tests assert the command sequence the
 * provisioner issues against a fake `exec`, not the
 * behaviour of git itself.
 */

import { describe, expect, it } from "vitest";
import {
	createFixWorktreeProvisioner,
	type FixWorktreeRequest,
	fixWorktreePath,
} from "../../../extensions/pr-workflow/fix-worktree.js";
import type {
	GitExec,
	GitExecResult,
} from "../../../extensions/pr-workflow/worktree-git.js";

const REQ: FixWorktreeRequest = {
	owner: "octocat",
	repo: "hello-world",
	number: 42,
	branch: "feature/x",
};

interface Call {
	args: string[];
	cwd?: string;
}

function fakeExec(scripted: Record<string, GitExecResult> = {}): {
	exec: GitExec;
	calls: Call[];
} {
	const calls: Call[] = [];
	const exec: GitExec = async (args, cwd) => {
		calls.push({ args, cwd });
		const key = args.join(" ");
		if (key in scripted) return scripted[key];
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { exec, calls };
}

describe("fixWorktreePath", () => {
	it("is keyed by PR number, not SHA, so it survives fixup commits", () => {
		// The fix loop adds commits to the PR branch; the
		// head SHA changes each commit. The worktree path
		// must NOT change, otherwise every fix-next would
		// re-provision a fresh tree and stomp on the
		// in-progress fix.
		const a = fixWorktreePath("/tmp/state", REQ);
		const b = fixWorktreePath("/tmp/state", { ...REQ });
		expect(a).toBe(b);
		expect(a).toBe("/tmp/state/fix-worktrees/octocat-hello-world-42");
	});

	it("scopes by owner-repo so two PRs in different repos don't collide", () => {
		const a = fixWorktreePath("/tmp/state", REQ);
		const b = fixWorktreePath("/tmp/state", {
			...REQ,
			repo: "other-world",
		});
		expect(a).not.toBe(b);
	});
});

describe("createFixWorktreeProvisioner — first run", () => {
	it("fetches the branch then adds a branch-tracking worktree", async () => {
		const { exec, calls } = fakeExec();
		const provision = createFixWorktreeProvisioner({
			stateDir: "/tmp/state",
			resolveSourceRepo: async () => "/src/octocat/hello-world",
			exec,
			pathExists: async () => false,
		});

		const handle = await provision(REQ);

		expect(handle.path).toBe("/tmp/state/fix-worktrees/octocat-hello-world-42");
		expect(handle.branch).toBe("feature/x");
		// Two commands, both against the user's clone:
		expect(calls).toEqual([
			{
				args: ["fetch", "origin", "feature/x"],
				cwd: "/src/octocat/hello-world",
			},
			{
				args: [
					"worktree",
					"add",
					"/tmp/state/fix-worktrees/octocat-hello-world-42",
					"-B",
					"feature/x",
					"origin/feature/x",
				],
				cwd: "/src/octocat/hello-world",
			},
		]);
	});

	it("throws with a useful message when fetch fails", async () => {
		const { exec } = fakeExec({
			"fetch origin feature/x": {
				exitCode: 128,
				stdout: "",
				stderr: "fatal: couldn't find remote ref feature/x",
			},
		});
		const provision = createFixWorktreeProvisioner({
			stateDir: "/tmp/state",
			resolveSourceRepo: async () => "/src/octocat/hello-world",
			exec,
			pathExists: async () => false,
		});

		await expect(provision(REQ)).rejects.toThrow(/couldn't find remote ref/);
	});

	it("throws when worktree add fails", async () => {
		const { exec } = fakeExec({
			"worktree add /tmp/state/fix-worktrees/octocat-hello-world-42 -B feature/x origin/feature/x":
				{
					exitCode: 128,
					stdout: "",
					stderr: "fatal: branch already checked out at /elsewhere",
				},
		});
		const provision = createFixWorktreeProvisioner({
			stateDir: "/tmp/state",
			resolveSourceRepo: async () => "/src/octocat/hello-world",
			exec,
			pathExists: async () => false,
		});

		await expect(provision(REQ)).rejects.toThrow(/already checked out/);
	});
});

describe("createFixWorktreeProvisioner — reuse", () => {
	it("skips fetch + add when the worktree path already exists", async () => {
		// Once a fix worktree has been provisioned, the
		// agent has been making commits in it. We must not
		// re-fetch and reset the branch, or in-progress
		// work disappears.
		const { exec, calls } = fakeExec();
		const provision = createFixWorktreeProvisioner({
			stateDir: "/tmp/state",
			resolveSourceRepo: async () => "/src/octocat/hello-world",
			exec,
			pathExists: async () => true,
		});

		const handle = await provision(REQ);

		expect(handle.path).toBe("/tmp/state/fix-worktrees/octocat-hello-world-42");
		expect(handle.branch).toBe("feature/x");
		expect(calls).toEqual([]);
	});
});
