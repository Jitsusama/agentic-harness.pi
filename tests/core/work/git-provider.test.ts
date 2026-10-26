import { describe, expect, it } from "vitest";
import type { RepoLocator } from "../../../lib/core/review/index.ts";
import { createGitTreeProvider } from "../../../lib/core/work/providers/git.ts";
import { type TreeRequest, treeIdentity } from "../../../lib/core/work/tree.ts";
import { fakeExec } from "../support/fake-exec.ts";

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
/** A snapshot pinned at `commit`. */
const pinned = (commit: string): TreeRequest => ({
	intent: "snapshot",
	repo: checkedOut,
	purpose: "Shopify/world#42",
	commit,
});
const worktree = (
	repo = checkedOut,
): Extract<TreeRequest, { intent: "worktree" }> => ({
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
	{ when: ["--verify", "refs/heads/"], stdout: "abc123\n" },
	{ when: ["cat-file"], stdout: "" },
	{ when: ["worktree"], stdout: "" },
];

/** A repo where the branch asked for is on neither side yet. */
const fresh = [
	{ when: ["rev-parse", "HEAD"], code: 128, stderr: "not a git repository" },
	{ when: ["--verify"], code: 1 },
	{ when: ["symbolic-ref"], stdout: "refs/remotes/origin/main\n" },
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

	it("makes a branch nobody has yet from the remote's default, tracking nothing", async () => {
		// `worktree add <path> <branch>` needs the branch to exist, so every
		// new piece of work began with `invalid reference` and a retry.
		// Tracking origin's default would make a later lease compare the
		// branch against main.
		const { exec, calls } = fakeExec(fresh);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		const { path } = await provider.ensure(worktree());

		expect(addition(calls)?.args).toEqual([
			"-C",
			"/src/world",
			"worktree",
			"add",
			"--no-track",
			"-b",
			"fix/thing",
			path,
			"origin/main",
		]);
	});

	it("makes the new branch from the base it was asked for", async () => {
		const { exec, calls } = fakeExec(fresh);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await provider.ensure({ ...worktree(), baseBranch: "release" });

		expect(addition(calls)?.args.at(-1)).toBe("release");
	});

	it("follows the remote's branch when only the remote has it", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["--verify", "refs/heads/"], code: 1 },
			{ when: ["--verify", "refs/remotes/origin/fix/thing"], stdout: "a\n" },
			{ when: ["worktree"], stdout: "" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		const { path } = await provider.ensure(worktree());

		expect(addition(calls)?.args.slice(4)).toEqual([
			"--track",
			"-b",
			"fix/thing",
			path,
			"origin/fix/thing",
		]);
	});

	it("says what to do when another checkout holds the branch", async () => {
		const { exec } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["--verify"], stdout: "a\n" },
			{
				when: ["worktree"],
				code: 128,
				stderr: "fatal: 'main' is already used by worktree at '/src/world'",
			},
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(
			provider.ensure({ ...worktree(), branch: "main" }),
		).rejects.toThrow(/\/src\/world.*new branch/s);
	});

	it("refuses a remote's branch as the branch to work on", async () => {
		// Asked for origin/main, it found no local branch and no
		// origin/origin/main, and made a local branch called origin/main,
		// which then shadowed origin's own in every command that named it.
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["--verify", "refs/heads/origin/main"], code: 1 },
			{ when: ["--verify", "refs/remotes/origin/origin/main"], code: 1 },
			{ when: ["--verify", "refs/remotes/origin/main"], stdout: "a\n" },
			{ when: ["symbolic-ref"], stdout: "refs/remotes/origin/main\n" },
			{ when: ["worktree"], stdout: "" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(
			provider.ensure({ ...worktree(), branch: "origin/main" }),
		).rejects.toThrow(
			/origin\/main is a remote's branch.*shadow.*name the branch.*snapshot/s,
		);
		expect(addition(calls)).toBeUndefined();
	});

	it("refuses a ref's full name as the branch to work on", async () => {
		// Given refs/remotes/origin/main, nothing bore it under refs/heads
		// or the remotes, so a branch refs/heads/refs/remotes/origin/main
		// was made, shadowing origin's main for git's every lookup.
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["--verify"], code: 1 },
			{ when: ["symbolic-ref"], stdout: "refs/remotes/origin/main\n" },
			{ when: ["worktree"], stdout: "" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(
			provider.ensure({ ...worktree(), branch: "refs/remotes/origin/main" }),
		).rejects.toThrow(/refs\/remotes\/origin\/main is a ref's full name/);
		expect(addition(calls)).toBeUndefined();
	});

	it("works on a local branch of that name when there is one", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["--verify", "refs/heads/origin/main"], stdout: "a\n" },
			{ when: ["worktree"], stdout: "" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		const { path } = await provider.ensure({
			...worktree(),
			branch: "origin/main",
		});

		expect(addition(calls)?.args.slice(4)).toEqual([path, "origin/main"]);
	});

	const FULL = "fd2a6a5c8a1e21dc0dc2d2d5caabcbadbd32c7ae";

	it("fetches a commit it does not have before pinning it", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["cat-file"], code: 1 },
			{ when: ["fetch"], stdout: "" },
			{ when: ["worktree"], stdout: "" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await provider.ensure(pinned(FULL));

		const fetched = calls.findIndex((call) => call.args.includes("fetch"));
		expect(calls[fetched]?.args).toContain(FULL);
		expect(fetched).toBeLessThan(
			calls.findIndex((call) => call.args.includes("add")),
		);
	});

	it("looks for a short commit it does not have on origin's branches", async () => {
		// git fetches by a full id only. Asked for fd2a6a5c8a1e, a merge
		// just made on origin's main, the fetch by that id fetched
		// nothing, and the cut failed with git's bare "invalid
		// reference". Origin's branches are where a commit somebody
		// means usually is, so they are fetched instead.
		const { exec: before, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["cat-file"], code: 1 },
			{ when: ["fetch"], stdout: "" },
			{ when: ["worktree"], stdout: "" },
		]);
		// The commit is here once origin's branches are.
		let came = false;
		const exec: typeof before = async (command, args) => {
			if (args.includes("fetch")) came = true;
			if (came && args.includes("cat-file")) {
				calls.push({ command, args });
				return { code: 0, stdout: "", stderr: "" };
			}
			return before(command, args);
		};
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await provider.ensure(pinned(FULL.slice(0, 12)));

		expect(addition(calls)?.args).toContain(FULL.slice(0, 12));
		const fetched = calls.find((call) => call.args.includes("fetch"));
		expect(fetched?.args).toEqual([
			"-C",
			"/src/world",
			"fetch",
			"--quiet",
			"--no-tags",
			"origin",
		]);
	});

	it("says a short commit is on neither side, and what to give instead", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], code: 128 },
			{ when: ["cat-file"], code: 1 },
			{ when: ["fetch"], stdout: "" },
			{ when: ["worktree"], stdout: "" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(provider.ensure(pinned("0123456789ab"))).rejects.toThrow(
			/0123456789ab.*origin.*full id/s,
		);
		expect(addition(calls)).toBeUndefined();
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
			{ when: ["cat-file"], stdout: "" },
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

// Agents' builds in a tree beside Joel's files held btrfs's lock and log
// for that subvolume, so an app's save waited behind them: p99 600 ms
// beside 20 builds, 18 ms with the builds in a subvolume of their own.
describe("a tree cut on btrfs", () => {
	const onBtrfs = async () => true;
	const path = "/state/worktree-github-Shopify-world-fix-thing";

	it("is a subvolume of its own, made before git fills it", async () => {
		const { exec, calls } = fakeExec([
			...ok,
			{ when: ["subvolume", "create"], stdout: "" },
		]);
		const provider = createGitTreeProvider({
			exec,
			stateDir: "/state",
			subvolumes: onBtrfs,
		});

		await provider.ensure(worktree());

		const made = calls.findIndex((call) => call.command === "btrfs");
		expect(calls[made]?.args).toEqual(["subvolume", "create", path]);
		expect(made).toBeLessThan(
			calls.findIndex((call) => call.args.includes("add")),
		);
	});

	it("is a plain directory where the state directory isn't on btrfs", async () => {
		const { exec, calls } = fakeExec(ok);
		const provider = createGitTreeProvider({
			exec,
			stateDir: "/state",
			subvolumes: async () => false,
		});

		await provider.ensure(snapshot());

		expect(calls.some((call) => call.command === "btrfs")).toBe(false);
		expect(addition(calls)).toBeDefined();
	});

	it("is a plain directory when no subvolume can be made", async () => {
		const { exec, calls } = fakeExec([
			...ok,
			{ when: ["subvolume", "create"], code: 127, stderr: "btrfs: not found" },
		]);
		const provider = createGitTreeProvider({
			exec,
			stateDir: "/state",
			subvolumes: onBtrfs,
		});

		await expect(provider.ensure(worktree())).resolves.toEqual({ path });
		expect(addition(calls)).toBeDefined();
	});

	it("leaves no empty subvolume behind when git won't cut the tree", async () => {
		const { exec, calls } = fakeExec([
			{
				when: ["rev-parse", "HEAD"],
				code: 128,
				stderr: "not a git repository",
			},
			{ when: ["--verify", "refs/heads/"], stdout: "abc123\n" },
			{ when: ["subvolume", "create"], stdout: "" },
			{ when: ["worktree"], code: 128, stderr: "fatal: invalid reference" },
			{ when: [path], stdout: "" },
		]);
		const provider = createGitTreeProvider({
			exec,
			stateDir: "/state",
			subvolumes: onBtrfs,
		});

		await expect(provider.ensure(worktree())).rejects.toThrow(
			/fatal: invalid reference/,
		);
		// An empty subvolume goes with rmdir, as its owner, needing no root.
		expect(calls.at(-1)).toEqual({ command: "rmdir", args: [path] });
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

	it("takes a short id for the full one it begins", async () => {
		const provider = createGitTreeProvider({
			exec: standingAt(SHA, []),
			stateDir: "/state",
		});

		const held = await provider.ensure({
			intent: "snapshot",
			repo: { key: "github:o/r", localPath: "/checkout" },
			purpose: "review",
			commit: SHA.slice(0, 12),
		});

		expect(held.path).toContain("snapshot-github-o-r-");
	});

	it("hands back a worktree still on the branch asked for", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "HEAD"], stdout: `${SHA}\n` },
			{ when: ["symbolic-ref", "HEAD"], stdout: "fix/thing\n" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		const held = await provider.ensure(worktree());

		expect(held.path).toBe(`/state/${treeIdentity(worktree()).key}`);
		expect(addition(calls)).toBeUndefined();
	});

	it("refuses a worktree that has moved to another branch since it was cut", async () => {
		// A tree is named for the branch it was cut on. One moved to another
		// branch afterwards was handed back to the next caller asking for the
		// first, for a purpose of its own, still on the other branch.
		const { exec } = fakeExec([
			{ when: ["rev-parse", "HEAD"], stdout: `${SHA}\n` },
			{ when: ["symbolic-ref", "HEAD"], stdout: "jg/test-in-containers\n" },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(provider.ensure(worktree())).rejects.toThrow(
			/stands on jg\/test-in-containers rather than fix\/thing.*[Rr]elease it.*ask for jg\/test-in-containers/s,
		);
	});

	it("refuses a worktree whose branch was left for a bare commit", async () => {
		const { exec } = fakeExec([
			{ when: ["rev-parse", "HEAD"], stdout: `${SHA}\n` },
			{ when: ["symbolic-ref", "HEAD"], code: 1 },
		]);
		const provider = createGitTreeProvider({ exec, stateDir: "/state" });

		await expect(provider.ensure(worktree())).rejects.toThrow(
			/stands detached at 1f271300bc9b rather than on fix\/thing/,
		);
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

	it("runs a call's git under that call's signal, so stopping the call stops git", async () => {
		const standing = fakeExec(ok);
		const stoppable = fakeExec(ok);
		const asked: AbortSignal[] = [];
		const provider = createGitTreeProvider({
			exec: standing.exec,
			execFor(signal) {
				asked.push(signal);
				return stoppable.exec;
			},
			stateDir: "/state",
		});
		const { signal } = new AbortController();

		const held = await provider.ensure(snapshot(), { signal });
		await provider.release(
			{
				identity: treeIdentity(snapshot()),
				path: held.path,
				providerId: provider.id,
			},
			{ signal },
		);

		expect(asked).toEqual([signal, signal]);
		expect(addition(stoppable.calls)).toBeDefined();
		expect(stoppable.calls.some((call) => call.args.includes("remove"))).toBe(
			true,
		);
		expect(standing.calls).toEqual([]);
	});

	it("keeps its standing exec for a call nobody can stop", async () => {
		const standing = fakeExec(ok);
		const provider = createGitTreeProvider({
			exec: standing.exec,
			execFor: () => {
				throw new Error("asked for a stoppable exec with no signal");
			},
			stateDir: "/state",
		});

		await provider.ensure(snapshot());

		expect(addition(standing.calls)).toBeDefined();
	});
});
