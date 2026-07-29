import { describe, expect, it } from "vitest";
import type { RepoLocator } from "../../../lib/review/index.js";
import {
	satisfies,
	type TreeRequest,
	treeIdentity,
} from "../../../lib/work/tree.js";

const world: RepoLocator = {
	key: "github:Shopify/world",
	localPath: "/src/github.com/Shopify/world",
};
const other: RepoLocator = { key: "meteorite:shop/world" };

const snapshot = (commit: string, repo = world): TreeRequest => ({
	intent: "snapshot",
	repo,
	purpose: "Shopify/world#42",
	commit,
});

const worktree = (branch: string, repo = world): TreeRequest => ({
	intent: "worktree",
	repo,
	purpose: "fix-the-thing",
	branch,
});

describe("treeIdentity", () => {
	it("pins a snapshot to its commit", () => {
		expect(
			satisfies(treeIdentity(snapshot("abc123")), snapshot("abc123")),
		).toBe(true);
		expect(
			satisfies(treeIdentity(snapshot("abc123")), snapshot("def456")),
		).toBe(false);
	});

	it("does not pin a worktree to a commit, because the branch moves under it", () => {
		// The whole point of a worktree is that you commit in it.
		// If its identity moved with HEAD, every commit would
		// orphan the tree you are working in.
		const held = treeIdentity(worktree("fix/thing"));

		expect(satisfies(held, worktree("fix/thing"))).toBe(true);
	});

	it("distinguishes two worktrees by branch", () => {
		expect(
			satisfies(treeIdentity(worktree("fix/one")), worktree("fix/two")),
		).toBe(false);
	});

	it("scopes identity to the repo, so one branch name in two repos is two trees", () => {
		expect(
			satisfies(treeIdentity(worktree("main", world)), worktree("main", other)),
		).toBe(false);
	});

	it("scopes a snapshot to the repo too, since two repos can share a commit", () => {
		expect(
			satisfies(
				treeIdentity(snapshot("abc123", world)),
				snapshot("abc123", other),
			),
		).toBe(false);
	});

	it("never confuses a snapshot with a worktree", () => {
		const held = treeIdentity(snapshot("abc123"));
		const asWorktree: TreeRequest = {
			intent: "worktree",
			repo: world,
			purpose: "Shopify/world#42",
			branch: "abc123",
		};

		expect(satisfies(held, asWorktree)).toBe(false);
	});

	it("survives being used as a directory name", () => {
		// Change labels carry slashes and hashes, and a repo key
		// carries a colon. A key that reaches the filesystem with
		// those in it either nests unexpectedly or fails outright.
		const { key } = treeIdentity(snapshot("abc123"));

		expect(key).not.toMatch(/[/\\:#]/);
		expect(key.length).toBeGreaterThan(0);
	});

	it("shares a snapshot between readers but never a worktree", () => {
		// Two reviewers reading the same commit can read the same
		// tree. Two people editing cannot, and the difference is
		// not a caller's judgement call.
		expect(treeIdentity(snapshot("abc123")).shareable).toBe(true);
		expect(treeIdentity(worktree("fix/thing")).shareable).toBe(false);
	});

	it("ignores the paths a snapshot asked to scope to", () => {
		// Scoping is a provider's optimisation, not part of what
		// the tree is. A snapshot narrowed to two files still
		// answers for the same commit, so re-asking with a wider
		// set must not silently reuse a narrower tree... but it
		// must not fragment the cache either. Identity stays on
		// the commit; a provider that scopes owns that tension.
		//
		// Built out rather than spread from the helper: spreading a
		// union value and adding a field narrows to the wrong arm.
		const narrow: TreeRequest = {
			intent: "snapshot",
			repo: world,
			purpose: "Shopify/world#42",
			commit: "abc123",
			paths: ["a.ts"],
		};
		const wide: TreeRequest = { ...narrow, paths: ["a.ts", "b.ts"] };

		expect(treeIdentity(narrow).key).toBe(treeIdentity(wide).key);
	});

	it("gives the same request the same identity every time", () => {
		expect(treeIdentity(snapshot("abc123")).key).toBe(
			treeIdentity(snapshot("abc123")).key,
		);
	});
});
