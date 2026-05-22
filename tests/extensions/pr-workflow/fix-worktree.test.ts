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
	cleanupFixWorktree,
	createFixWorktreeProvisioner,
	type FixWorktreeFs,
	type FixWorktreeProvider,
	FixWorktreeProviderBroker,
	type FixWorktreeRequest,
	fixWorktreePath,
	isFixWorktreeProvider,
	listFixWorktrees,
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

function fakeProvider(
	overrides: Partial<FixWorktreeProvider> = {},
): FixWorktreeProvider {
	const id = overrides.id ?? "fake";
	return {
		id,
		async provision(request) {
			return {
				path: `/provider/${id}/${request.owner}/${request.repo}/${request.number}`,
				branch: request.branch,
				providerId: id,
			};
		},
		async list() {
			return [
				{
					slug: "provider-entry",
					path: "/provider/entry",
					owner: "octocat",
					repo: "hello-world",
					number: 42,
					mtimeMs: 1,
				},
			];
		},
		async cleanup(request) {
			return {
				status: "removed",
				path: `/provider/${id}/${request.owner}/${request.repo}/${request.number}`,
				method: "git",
			};
		},
		...overrides,
	};
}

describe("FixWorktreeProviderBroker", () => {
	it("uses the highest-priority provider that can handle the request", async () => {
		const fallback = fakeProvider({ id: "git" });
		const world = fakeProvider({
			id: "world",
			priority: 100,
			canHandle: (request) => request.owner === "shop",
		});
		const broker = new FixWorktreeProviderBroker(fallback);
		broker.register(world);

		const handle = await broker.provision({
			owner: "shop",
			repo: "world",
			number: 7,
			branch: "feature",
		});

		expect(handle.path).toBe("/provider/world/shop/world/7");
		expect(broker.providerIds()).toEqual(["world", "git"]);
	});

	it("falls back when registered providers decline the request", async () => {
		const fallback = fakeProvider({ id: "git" });
		const custom = fakeProvider({
			id: "custom",
			priority: 100,
			canHandle: () => false,
		});
		const broker = new FixWorktreeProviderBroker(fallback);
		broker.register(custom);

		const handle = await broker.provision(REQ);

		expect(handle.path).toBe("/provider/git/octocat/hello-world/42");
	});

	it("routes cleanup to the matching provider", async () => {
		const fallback = fakeProvider({ id: "git" });
		const cleaned: string[] = [];
		const custom = fakeProvider({
			id: "custom",
			priority: 100,
			canHandle: (request) => request.repo === "hello-world",
			async cleanup(request) {
				cleaned.push(`${request.owner}/${request.repo}#${request.number}`);
				return { status: "removed", path: "/custom", method: "git" };
			},
		});
		const broker = new FixWorktreeProviderBroker(fallback);
		broker.register(custom);

		await broker.cleanup({ owner: "octocat", repo: "hello-world", number: 42 });

		expect(cleaned).toEqual(["octocat/hello-world#42"]);
	});

	it("rejects invalid event-bus providers", () => {
		expect(isFixWorktreeProvider(fakeProvider())).toBe(true);
		expect(isFixWorktreeProvider(null)).toBe(false);
		expect(
			isFixWorktreeProvider({ id: "bad", provision: async () => ({}) }),
		).toBe(false);
	});
});

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

function inMemoryFs(
	initial: Record<string, { mtimeMs?: number; isDir?: boolean }> = {},
): FixWorktreeFs & { removed: string[] } {
	const paths: Record<string, { mtimeMs?: number; isDir?: boolean }> = {
		...initial,
	};
	const removed: string[] = [];
	return {
		removed,
		async listDirs(dir) {
			const prefix = `${dir}/`;
			const names = new Set<string>();
			for (const key of Object.keys(paths)) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const first = rest.split("/")[0];
				if (first && paths[`${prefix}${first}`]?.isDir !== false) {
					names.add(first);
				}
			}
			return Array.from(names);
		},
		async stat(p) {
			const entry = paths[p];
			if (!entry) return null;
			return { mtimeMs: entry.mtimeMs ?? 0 };
		},
		async remove(p) {
			removed.push(p);
			for (const key of Object.keys(paths)) {
				if (key === p || key.startsWith(`${p}/`)) delete paths[key];
			}
		},
		async exists(p) {
			return p in paths;
		},
	};
}

describe("listFixWorktrees", () => {
	it("returns an empty list when the fix-worktrees directory is absent", async () => {
		const fs = inMemoryFs();
		expect(await listFixWorktrees("/tmp/state", fs)).toEqual([]);
	});

	it("enumerates owner-repo-number entries with mtimes", async () => {
		const fs = inMemoryFs({
			"/tmp/state/fix-worktrees/octocat-hello-world-42": { mtimeMs: 200 },
			"/tmp/state/fix-worktrees/octocat-other-7": { mtimeMs: 100 },
		});
		const entries = await listFixWorktrees("/tmp/state", fs);
		expect(entries).toHaveLength(2);
		// Sorted oldest-first.
		expect(entries[0]?.path).toBe("/tmp/state/fix-worktrees/octocat-other-7");
		expect(entries[0]?.number).toBe(7);
		expect(entries[0]?.repo).toBe("other");
		expect(entries[1]?.owner).toBe("octocat");
		expect(entries[1]?.repo).toBe("hello-world");
		expect(entries[1]?.number).toBe(42);
	});

	it("ignores directories that don't match the slug shape", async () => {
		const fs = inMemoryFs({
			"/tmp/state/fix-worktrees/garbage-no-number": {},
			"/tmp/state/fix-worktrees/missing-owner-7": { mtimeMs: 1 },
			"/tmp/state/fix-worktrees/octocat-hello-world-99": { mtimeMs: 2 },
		});
		const entries = await listFixWorktrees("/tmp/state", fs);
		const slugs = entries.map((e) => e.slug);
		expect(slugs).toContain("missing-owner-7");
		expect(slugs).toContain("octocat-hello-world-99");
		expect(slugs).not.toContain("garbage-no-number");
	});
});

describe("cleanupFixWorktree", () => {
	const target = "/tmp/state/fix-worktrees/octocat-hello-world-42";

	it("reports missing when the worktree path doesn't exist", async () => {
		const fs = inMemoryFs();
		const { exec, calls } = fakeExec();
		const outcome = await cleanupFixWorktree(
			{
				stateDir: "/tmp/state",
				owner: "octocat",
				repo: "hello-world",
				number: 42,
			},
			exec,
			fs,
		);
		expect(outcome).toEqual({ status: "missing", path: target });
		expect(calls).toEqual([]);
	});

	it("runs `git worktree remove` and reports the git method on success", async () => {
		const fs = inMemoryFs({ [target]: { mtimeMs: 1 } });
		const { exec, calls } = fakeExec();
		const outcome = await cleanupFixWorktree(
			{
				stateDir: "/tmp/state",
				owner: "octocat",
				repo: "hello-world",
				number: 42,
			},
			exec,
			fs,
		);
		expect(outcome).toEqual({
			status: "removed",
			path: target,
			method: "git",
		});
		expect(calls).toEqual([
			{ args: ["worktree", "remove", target], cwd: target },
		]);
		expect(fs.removed).toEqual([]);
	});

	it("blocks when git refuses and force is not set", async () => {
		const fs = inMemoryFs({ [target]: { mtimeMs: 1 } });
		const { exec } = fakeExec({
			[`worktree remove ${target}`]: {
				exitCode: 128,
				stdout: "",
				stderr: "fatal: contains uncommitted changes",
			},
		});
		const outcome = await cleanupFixWorktree(
			{
				stateDir: "/tmp/state",
				owner: "octocat",
				repo: "hello-world",
				number: 42,
			},
			exec,
			fs,
		);
		expect(outcome.status).toBe("blocked");
		if (outcome.status === "blocked") {
			expect(outcome.reason).toBe("fatal: contains uncommitted changes");
			expect(outcome.hint).toContain("force:true");
		}
		expect(fs.removed).toEqual([]);
	});

	it("falls back to rm -rf when git refuses and force is true", async () => {
		const fs = inMemoryFs({ [target]: { mtimeMs: 1 } });
		const { exec } = fakeExec({
			[`worktree remove ${target}`]: {
				exitCode: 128,
				stdout: "",
				stderr: "fatal: refused",
			},
		});
		const outcome = await cleanupFixWorktree(
			{
				stateDir: "/tmp/state",
				owner: "octocat",
				repo: "hello-world",
				number: 42,
				force: true,
			},
			exec,
			fs,
		);
		expect(outcome).toEqual({
			status: "removed",
			path: target,
			method: "force",
		});
		expect(fs.removed).toEqual([target]);
	});
});
