import { describe, expect, it } from "vitest";
import type { WorktreeRequest } from "../../../extensions/pr-workflow/worktree.js";
import {
	createGitWorktreeProvider,
	type GitExec,
	type GitExecResult,
} from "../../../extensions/pr-workflow/worktree-git.js";

/**
 * The git provider shells out to `git worktree add` and
 * `git worktree remove`. These tests inject a fake exec
 * so they assert the command sequence the provider issues,
 * not the behaviour of git itself. A real-git integration
 * test belongs in a separate file (slower, needs a temp
 * repo); this file is the fast-feedback unit layer.
 */

const REQ: WorktreeRequest = {
	owner: "octocat",
	repo: "hello-world",
	sha: "abc123def456",
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

describe("createGitWorktreeProvider — ensure()", () => {
	it("creates a worktree at <stateDir>/worktrees/<owner>-<repo>/<sha>", async () => {
		// XDG-shaped path so all session worktrees end up
		// in a single inspectable location and are scoped
		// by owner/repo/sha.
		const { exec, calls } = fakeExec();
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/pi-state",
			resolveSourceRepo: async () => "/home/me/src/octocat/hello-world",
			exec,
		});
		const handle = await provider.ensure(REQ);
		expect(handle.path).toBe(
			"/tmp/pi-state/worktrees/octocat-hello-world/abc123def456",
		);
		expect(handle.sha).toBe("abc123def456");
		expect(handle.providerId).toBe("git");
		// First call must be against the resolved source
		// repo, and must include `worktree add --detach`
		// pointing at the target path and SHA.
		const addCall = calls.find(
			(c) => c.args.slice(0, 3).join(" ") === "worktree add --detach",
		);
		expect(addCall).toBeDefined();
		expect(addCall?.cwd).toBe("/home/me/src/octocat/hello-world");
		expect(addCall?.args).toContain(
			"/tmp/pi-state/worktrees/octocat-hello-world/abc123def456",
		);
		expect(addCall?.args).toContain("abc123def456");
	});

	it("stamps the source repo path onto the handle's marker", async () => {
		// release() needs to know which clone to call
		// `git worktree remove` against. We stamp the
		// resolved source path onto the handle so release
		// is self-contained.
		const { exec } = fakeExec();
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async () => "/srv/clone",
			exec,
		});
		const handle = await provider.ensure(REQ);
		expect(handle.marker).toBe("/srv/clone");
	});

	it("reuses an existing worktree when its HEAD already matches the requested SHA", async () => {
		// Idempotent ensure: if the path already exists
		// and points at the same SHA, no `worktree add`
		// call is issued. This is what makes repeated
		// calls during a session cheap.
		const targetPath = "/tmp/s/worktrees/octocat-hello-world/abc123def456";
		const { exec, calls } = fakeExec({
			// First call the provider makes is a HEAD probe
			// at the target path.
			[`rev-parse HEAD`]: {
				stdout: "abc123def456\n",
				stderr: "",
				exitCode: 0,
			},
		});
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async () => "/srv/clone",
			exec,
			pathExists: async (p) => p === targetPath,
		});
		await provider.ensure(REQ);
		// No worktree-add command was issued because the
		// existing worktree matched.
		const addCall = calls.find(
			(c) => c.args.slice(0, 2).join(" ") === "worktree add",
		);
		expect(addCall).toBeUndefined();
	});

	it("re-creates the worktree when the existing path points at a different SHA", async () => {
		// Stale worktree (left from a previous session at
		// a different head): remove and re-add. We do not
		// silently reuse a tree pointing at the wrong SHA.
		const targetPath = "/tmp/s/worktrees/octocat-hello-world/abc123def456";
		const { exec, calls } = fakeExec({
			[`rev-parse HEAD`]: {
				stdout: "deadbeef\n",
				stderr: "",
				exitCode: 0,
			},
		});
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async () => "/srv/clone",
			exec,
			pathExists: async (p) => p === targetPath,
		});
		await provider.ensure(REQ);
		const sequence = calls.map((c) => c.args.slice(0, 2).join(" "));
		const removeIdx = sequence.indexOf("worktree remove");
		const addIdx = sequence.indexOf("worktree add");
		expect(removeIdx).toBeGreaterThanOrEqual(0);
		expect(addIdx).toBeGreaterThan(removeIdx);
	});

	it("falls back to ensuring the source repo via resolveSourceRepo", async () => {
		// The provider doesn't hardcode where the user's
		// clone lives. The resolver is what makes it
		// pluggable (and lets tests inject a path).
		const { exec } = fakeExec();
		let resolveCalls = 0;
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async (req) => {
				resolveCalls++;
				expect(req).toEqual(REQ);
				return "/elsewhere/clone";
			},
			exec,
		});
		const handle = await provider.ensure(REQ);
		expect(resolveCalls).toBe(1);
		expect(handle.marker).toBe("/elsewhere/clone");
	});

	it("propagates a non-zero git worktree add as an error", async () => {
		// A failed worktree-add must not produce a handle.
		// Returning a bogus handle would mislead the caller
		// into thinking the worktree exists.
		const exec: GitExec = async (args) => {
			if (args[0] === "worktree" && args[1] === "add") {
				return {
					stdout: "",
					stderr: "fatal: '/foo' is not a git repository",
					exitCode: 128,
				};
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async () => "/srv/clone",
			exec,
		});
		await expect(provider.ensure(REQ)).rejects.toThrow(/worktree add/);
	});
});

describe("createGitWorktreeProvider — release()", () => {
	it("calls `git worktree remove --force` against the source repo", async () => {
		// Force is required because reviewers may have left
		// build artifacts in the tree; we don't prompt the
		// user on every council teardown.
		const { exec, calls } = fakeExec();
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async () => "/srv/clone",
			exec,
		});
		const handle = await provider.ensure(REQ);
		await provider.release(handle);
		const removeCall = calls.find(
			(c) =>
				c.args[0] === "worktree" &&
				c.args[1] === "remove" &&
				c.args.includes("--force"),
		);
		expect(removeCall).toBeDefined();
		expect(removeCall?.cwd).toBe("/srv/clone");
		expect(removeCall?.args).toContain(handle.path);
	});

	it("prunes after removing so git's worktree list stays clean", async () => {
		// `git worktree remove` leaves stale registry
		// entries behind in some failure modes. Prune
		// keeps `git worktree list` accurate across the
		// session.
		const { exec, calls } = fakeExec();
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async () => "/srv/clone",
			exec,
		});
		const handle = await provider.ensure(REQ);
		await provider.release(handle);
		const sequence = calls.map((c) => c.args.slice(0, 2).join(" "));
		const removeIdx = sequence.indexOf("worktree remove");
		const pruneIdx = sequence.indexOf("worktree prune");
		expect(removeIdx).toBeGreaterThan(-1);
		expect(pruneIdx).toBeGreaterThan(removeIdx);
	});

	it("propagates remove failures so callers can decide what to do", async () => {
		// The registry aggregates errors across multiple
		// releases. The provider's job is to surface its
		// own failures honestly.
		const exec: GitExec = async (args) => {
			if (args[0] === "worktree" && args[1] === "remove") {
				return {
					stdout: "",
					stderr: "fatal: cannot remove",
					exitCode: 128,
				};
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const provider = createGitWorktreeProvider({
			stateDir: "/tmp/s",
			resolveSourceRepo: async () => "/srv/clone",
			exec,
		});
		const handle = await provider.ensure(REQ);
		await expect(provider.release(handle)).rejects.toThrow(/cannot remove/);
	});
});
