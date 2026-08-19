import type { RepoLocator } from "@jitsusama/agentic-harness.core/review";
import { describe, expect, it } from "vitest";
import { createGitTreeProvider } from "../../../lib/work/providers/git.js";
import { type TreeRequest, treeIdentity } from "../../../lib/work/tree.js";
import { fakeExec } from "../../support/fake-exec.js";

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

/**
 * A repo where `worktree add` works and no tree has been cut yet.
 *
 * The second half matters: `ensure` asks whether one is already there
 * before cutting, so a fake that answers every command happily would
 * report a tree at every path and nothing would ever be cut.
 */
const ok = [
	{ when: ["rev-parse", "HEAD"], code: 128, stderr: "not a git repository" },
	{ when: ["worktree"], stdout: "" },
];

/** The `worktree add` among the calls, which is no longer the first one. */
function addition(
	calls: readonly { command: string; args: string[] }[],
): { command: string; args: string[] } | undefined {
	return calls.find((call) => call.args.includes("add"));
}

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

		expect(addition(calls)?.command).toBe("git");
		expect(addition(calls)?.args).toEqual([
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

		expect(addition(calls)?.args).toEqual([
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

		expect(addition(calls)?.args.slice(0, 2)).toEqual(["-C", "/src/world"]);
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

		// The whole argv, not two things it contains. This assertion
		// used toContain and so could not see that the command carried
		// no -C at all, which meant release ran against whatever repo
		// the process happened to sit in. git then says the path is not
		// a working tree, which is true of that repo and beside the
		// point. A loose assertion about argv cannot catch a missing
		// scope flag, and scope is most of what a git argv says.
		expect(calls[0]?.args).toEqual([
			"-C",
			"/state/snapshot-github-Shopify-world-abc123",
			"worktree",
			"remove",
			"/state/snapshot-github-Shopify-world-abc123",
		]);
	});
});

describe("a tree that is already there", () => {
	/** An exec that reports a worktree standing at the given commit. */
	function standingAt(head: string, seen: string[][]) {
		return async (_file: string, args: readonly string[]) => {
			seen.push([...args]);
			if (args.includes("rev-parse") && args.includes("HEAD")) {
				return { code: 0, stdout: `${head}\n`, stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
	}

	const SHA = "1f271300bc9bfff279d77f012281c6c1f20af598";

	it("hands back the snapshot a previous session cut", async () => {
		// The broker only remembers within a session while the directory
		// outlives it, so the second reader of a commit found the tree and
		// died on `already exists`, then read the working checkout instead.
		const seen: string[][] = [];
		const provider = createGitTreeProvider({
			exec: standingAt(SHA, seen),
			stateDir: "/state",
		});

		const held = await provider.ensure({
			intent: "snapshot",
			repo: { key: "github:o/r", localPath: "/checkout" },
			purpose: "review",
			commit: SHA,
		});

		expect(held.path).toContain("snapshot-github-o-r-");
		expect(seen.some((args) => args.includes("add"))).toBe(false);
	});

	it("refuses one standing at a different commit", async () => {
		// Reviewing a commit nobody asked about, while reporting the one
		// they did, is the only outcome here that cannot be noticed.
		const provider = createGitTreeProvider({
			exec: standingAt("0000000000000000000000000000000000000000", []),
			stateDir: "/state",
		});

		await expect(
			provider.ensure({
				intent: "snapshot",
				repo: { key: "github:o/r", localPath: "/checkout" },
				purpose: "review",
				commit: SHA,
			}),
		).rejects.toThrow(/stands at 0000000/);
	});

	it("cuts one when nothing is there", async () => {
		const seen: string[][] = [];
		const provider = createGitTreeProvider({
			exec: async (_file, args) => {
				seen.push([...args]);
				// What git says from a path that is not a worktree.
				if (args.includes("rev-parse")) {
					return { code: 128, stdout: "", stderr: "not a git repository" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
			stateDir: "/state",
		});

		await provider.ensure({
			intent: "snapshot",
			repo: { key: "github:o/r", localPath: "/checkout" },
			purpose: "review",
			commit: SHA,
		});

		expect(seen.some((args) => args.includes("add"))).toBe(true);
	});
});
