import { describe, expect, it } from "vitest";
import type { RepoLocator } from "../../../lib/review/index.js";
import { createGitTreeProvider } from "../../../lib/work/providers/git.js";
import { type TreeRequest, treeIdentity } from "../../../lib/work/tree.js";
import { fakeExec } from "../review/support/fake-exec.js";

const checkedOut: RepoLocator = {
	key: "github:Shopify/world",
	localPath: "/src/world",
	remoteUrl: "https://github.com/Shopify/world.git",
};
const remoteOnly: RepoLocator = {
	key: "github:Shopify/world",
	remoteUrl: "https://github.com/Shopify/world.git",
};
const unplaceable: RepoLocator = { key: "meteorite:shop/world" };

const snapshot = (repo = checkedOut): TreeRequest => ({
	intent: "snapshot",
	repo,
	purpose: "Shopify/world#42",
	commit: "abc123",
});
const worktree = (repo = checkedOut): TreeRequest => ({
	intent: "worktree",
	repo,
	purpose: "fix-the-thing",
	branch: "fix/thing",
});

const ok = [{ when: ["worktree"], stdout: "" }];

describe("createGitTreeProvider", () => {
	it("applies to any repo, as the general case", () => {
		const { exec } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		expect(provider.appliesTo(checkedOut)).toBe(true);
		expect(provider.appliesTo(unplaceable)).toBe(true);
		expect(provider.specificity).toBe(0);
	});

	it("detaches a snapshot at its commit", async () => {
		const { exec, calls } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		const { path } = await provider.ensure(snapshot());

		expect(calls[0]?.command).toBe("git");
		expect(calls[0]?.args).toEqual([
			"-C",
			"/src/world",
			"worktree",
			"add",
			"--detach",
			path,
			"abc123",
		]);
	});

	it("checks a worktree out at its branch", async () => {
		const { exec, calls } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		const { path } = await provider.ensure(worktree());

		expect(calls[0]?.args).toEqual([
			"-C",
			"/src/world",
			"worktree",
			"add",
			path,
			"fix/thing",
		]);
	});

	it("puts the tree under the state directory, named by its identity", async () => {
		const { exec } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		const { path } = await provider.ensure(snapshot());

		expect(path).toBe(`/state/${treeIdentity(snapshot()).key}`);
	});

	it("runs against the checkout the substrate already found", async () => {
		// Not a path derived from the repo key. That derivation is
		// the bug this whole library started from.
		const { exec, calls } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await provider.ensure(snapshot());

		expect(calls[0]?.args.slice(0, 2)).toEqual(["-C", "/src/world"]);
	});

	it("refuses a remote-only repo rather than cloning it", async () => {
		// A clone of an unasked-for repo can be enormous, and
		// silently spending ten minutes on one is a surprising
		// thing for a tool to do. Say what is needed instead.
		const { exec, calls } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(provider.ensure(snapshot(remoteOnly))).rejects.toThrow(
			/https:\/\/github.com\/Shopify\/world.git/,
		);
		expect(calls).toHaveLength(0);
	});

	it("refuses a repo it cannot place, naming it", async () => {
		const { exec } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(provider.ensure(snapshot(unplaceable))).rejects.toThrow(
			/meteorite:shop\/world/,
		);
	});

	it("keeps git's own words when git fails", async () => {
		const { exec } = fakeExec([
			{ when: ["worktree"], code: 128, stderr: "fatal: invalid reference" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(provider.ensure(snapshot())).rejects.toThrow(
			/fatal: invalid reference/,
		);
	});

	it("removes a tree it is asked to release", async () => {
		const { exec, calls } = fakeExec(ok);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await provider.release({
			identity: treeIdentity(snapshot()),
			path: "/state/snapshot-github-Shopify-world-abc123",
			providerId: provider.id,
		});

		expect(calls[0]?.args).toContain("remove");
		expect(calls[0]?.args).toContain(
			"/state/snapshot-github-Shopify-world-abc123",
		);
	});
});
