/**
 * Reading branch state out of a real repository.
 *
 * `tidyPlan` is pure and tested on its own, so what is left to get wrong
 * is the reading: three git invocations whose output has to line up into
 * one picture. A fake answers whatever it was told to, which makes a
 * wrong `--format` and a misread `gone` marker both look like passing
 * tests. The one that matters cannot be faked honestly at all: a squash
 * merge has to be performed to produce the state it leaves behind.
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_TIMED_OUT } from "../../../lib/core/exec/spawn.ts";
import {
	createGitHistory,
	orphanedTrees,
	tidyPlan,
} from "../../../lib/core/work/index.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

/** An exec over real processes, shaped the way the library expects. */
const exec = (command: string, args: readonly string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
		execFile(command, [...args], (error, stdout, stderr) =>
			done({
				code:
					error === null ? 0 : typeof error.code === "number" ? error.code : 1,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			}),
		),
	);

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) disposeRepo(dir);
	dirs = [];
});

/** A repo with a remote, so an upstream can be made to go away. */
async function repoWithRemote(): Promise<{ local: string; remote: string }> {
	const remote = await freshRepo("tidy-remote");
	const local = await freshRepo("tidy-local");
	dirs.push(remote, local);
	await git(remote, "config", "receive.denyCurrentBranch", "ignore");
	await git(local, "remote", "add", "origin", remote);
	await git(local, "fetch", "-q", "origin");
	await git(local, "branch", "--set-upstream-to=origin/main", "main");
	return { local, remote };
}

/** Commit one file on a new branch off main, and publish it. */
async function publishBranch(local: string, name: string): Promise<void> {
	await git(local, "checkout", "-q", "-b", name, "main");
	await git(local, "commit", "-q", "--allow-empty", "-m", `work on ${name}`);
	await git(local, "push", "-q", "-u", "origin", name);
}

describe("reading branch state from a real repository", () => {
	it("says which branches trunk already contains", async () => {
		const { local } = await repoWithRemote();
		await publishBranch(local, "landed");
		await git(local, "checkout", "-q", "main");
		await git(local, "merge", "-q", "--no-ff", "-m", "merge", "landed");

		const branches = await createGitHistory({ exec }).branches(local, "main");

		expect(branches.find((b) => b.name === "landed")).toMatchObject({
			mergedIntoTrunk: true,
		});
	});

	it("does not call an unmerged branch merged", async () => {
		const { local } = await repoWithRemote();
		await publishBranch(local, "wip");
		await git(local, "checkout", "-q", "main");

		const branches = await createGitHistory({ exec }).branches(local, "main");

		expect(branches.find((b) => b.name === "wip")).toMatchObject({
			mergedIntoTrunk: false,
		});
	});

	it("reports the upstream a branch tracks", async () => {
		const { local } = await repoWithRemote();
		await publishBranch(local, "tracked");

		const branches = await createGitHistory({ exec }).branches(local, "main");

		expect(branches.find((b) => b.name === "tracked")?.tracking).toBe(
			"origin/tracked",
		);
	});

	// The state a squash merge leaves, produced by performing one rather
	// than by describing one. Trunk holds the work as a new commit, so the
	// branch is not an ancestor of it, while the upstream is gone because
	// the merge removed it. Every fake of this is a guess about what git
	// prints in a situation nobody set up.
	it("marks an upstream that has gone, without calling the branch merged", async () => {
		const { local, remote } = await repoWithRemote();
		await publishBranch(local, "squashed");
		await git(local, "checkout", "-q", "main");
		await git(local, "merge", "-q", "--squash", "squashed");
		await git(local, "commit", "-q", "--allow-empty", "-m", "squashed in");
		await git(remote, "branch", "-D", "squashed");
		await git(local, "fetch", "-q", "--prune", "origin");

		const branches = await createGitHistory({ exec }).branches(local, "main");
		const squashed = branches.find((b) => b.name === "squashed");

		expect(squashed).toMatchObject({
			remoteGone: true,
			mergedIntoTrunk: false,
		});
	});

	// The two halves together, which is the claim the feature actually
	// makes: this state must not be offered for deletion, because -d
	// refuses it and -D would throw the commits away on a guess.
	it("leaves a squash-merged branch for a person to decide", async () => {
		const { local, remote } = await repoWithRemote();
		await publishBranch(local, "squashed");
		await git(local, "checkout", "-q", "main");
		await git(local, "merge", "-q", "--squash", "squashed");
		await git(local, "commit", "-q", "--allow-empty", "-m", "squashed in");
		await git(remote, "branch", "-D", "squashed");
		await git(local, "fetch", "-q", "--prune", "origin");

		const plan = tidyPlan({
			trunk: "main",
			current: "main",
			branches: await createGitHistory({ exec }).branches(local, "main"),
		});

		expect(plan.removable).toEqual([]);
		expect(plan.keeping.find((k) => k.branch === "squashed")).toMatchObject({
			decide: true,
		});
		expect(plan).toMatchObject({ prunable: true });
	});
});

describe("reading worktree state from a real repository", () => {
	// Performed rather than faked, for the reason the branch tests above
	// are: the porcelain format is a run of lines per tree and a wrong
	// parse of it produces an empty listing, which a fake would hand back
	// as cheerfully as a right one. Only real git can say the format is
	// what the code thinks it is.
	it("finds a merged tree nothing holds, and leaves a dirty one", async () => {
		const { local } = await repoWithRemote();
		const history = createGitHistory({ exec });

		// One tree whose branch main contains, which is the reclaimable
		// case, and one holding an uncommitted file, which is the refusal.
		await git(local, "branch", "spent", "main");
		await git(local, "worktree", "add", "-q", `${local}/.wt/spent`, "spent");
		await git(local, "checkout", "-q", "-b", "busy", "main");
		await git(local, "commit", "-q", "--allow-empty", "-m", "unlanded");
		await git(local, "checkout", "-q", "main");
		await git(local, "worktree", "add", "-q", `${local}/.wt/busy`, "busy");
		await writeFile(`${local}/.wt/busy/scratch.txt`, "not committed");

		const trees = await history.worktrees(local, "main");
		// The parse itself: three trees, the checkout and the two added.
		expect(trees).toHaveLength(3);
		expect(trees.map((t) => t.branch).sort()).toEqual([
			"busy",
			"main",
			"spent",
		]);

		const plan = orphanedTrees({
			// Resolved, as the caller is required to do, because git already
			// has: on macOS these fixtures live under a symlinked temp, so
			// git says `/private/var` where the test said `/var`.
			mainPath: realpathSync(local),
			worktrees: trees,
			remembered: [],
		});

		expect(plan.reclaimable).toEqual([
			{ path: realpathSync(`${local}/.wt/spent`), branch: "spent" },
		]);
		const busy = plan.retained.find((t) => t.path.endsWith("busy"));
		expect(busy?.why).toContain("uncommitted");
		expect(busy?.decide).toBeUndefined();
	});

	it("offers a snapshot at a branch's commit, and keeps one at a lone commit", async () => {
		const { local } = await repoWithRemote();
		const history = createGitHistory({ exec });

		// One detached at main's commit, as a snapshot is cut, and one
		// detached at a commit made there and named by nothing else.
		await git(local, "worktree", "add", "-q", "--detach", `${local}/.wt/read`);
		await git(local, "worktree", "add", "-q", "--detach", `${local}/.wt/lone`);
		await git(
			`${local}/.wt/lone`,
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"only here",
		);

		const plan = orphanedTrees({
			mainPath: realpathSync(local),
			worktrees: await history.worktrees(local, "main"),
			remembered: [],
		});

		expect(plan.reclaimable).toEqual([
			{ path: realpathSync(`${local}/.wt/read`) },
		]);
		const lone = plan.retained.find((t) => t.path.endsWith("lone"));
		expect(lone).toMatchObject({ decide: true });
	});

	it("passes over a tree whose folder has gone, and reads the rest", async () => {
		const { local } = await repoWithRemote();
		const history = createGitHistory({ exec });
		await git(local, "branch", "spent", "main");
		await git(local, "worktree", "add", "-q", `${local}/.wt/spent`, "spent");
		await git(local, "worktree", "add", "-q", "--detach", `${local}/.wt/gone`);
		// Deleted behind git's back, which leaves git's record of it, as a
		// tree cut under a temp folder that was later cleared does.
		await rm(`${local}/.wt/gone`, { recursive: true, force: true });

		const trees = await history.worktrees(local, "main");

		expect(trees.map((t) => t.path).sort()).toEqual(
			[realpathSync(local), realpathSync(`${local}/.wt/spent`)].sort(),
		);
	});

	it("passes over a bare repository's own record, and reads its trees", async () => {
		// As World is laid out: a bare common dir with linked worktrees.
		// The bare one has no work tree to ask the status of, and asking
		// refused the whole survey.
		const { local } = await repoWithRemote();
		const bare = `${local}/.bare`;
		await git(local, "clone", "-q", "--bare", local, bare);
		await git(bare, "worktree", "add", "-q", `${local}/.wt/root`, "main");
		await git(bare, "branch", "spent", "main");
		await git(bare, "worktree", "add", "-q", `${local}/.wt/spent`, "spent");
		const history = createGitHistory({ exec });

		const trees = await history.worktrees(`${local}/.wt/root`, "main");

		expect(trees.map((t) => t.path).sort()).toEqual(
			[
				realpathSync(`${local}/.wt/root`),
				realpathSync(`${local}/.wt/spent`),
			].sort(),
		);
	});

	it("leaves a tree something still claims", async () => {
		const { local } = await repoWithRemote();
		const history = createGitHistory({ exec });
		await git(local, "branch", "spent", "main");
		await git(local, "worktree", "add", "-q", `${local}/.wt/spent`, "spent");

		const plan = orphanedTrees({
			mainPath: realpathSync(local),
			worktrees: await history.worktrees(local, "main"),
			remembered: [realpathSync(`${local}/.wt/spent`)],
		});

		expect(plan.reclaimable).toEqual([]);
		expect(plan.retained.find((t) => t.path.endsWith("spent"))?.why).toContain(
			"give it back",
		);
	});
});

/** The real exec, keeping each git call's arguments as it goes. */
function recording(): {
	exec: typeof exec;
	calls: (readonly string[])[];
} {
	const calls: (readonly string[])[] = [];
	return {
		calls,
		exec: (command, args) => {
			calls.push(args);
			return exec(command, args);
		},
	};
}

// What each question costs on World, where tidy ran past 600 s on
// 10 November: 1,866 branches, 253 trees, 102 of them detached. Asking
// git how far each branch is from its upstream took 476 s there, and
// asking per detached tree whether a ref holds its commit took 14 s to
// 102 s a tree. The counts below are what keeps those from coming back.
describe("reading a repository with many branches and trees", () => {
	it("tells a gone upstream without counting how far each branch has moved", async () => {
		const { local, remote } = await repoWithRemote();
		await publishBranch(local, "squashed");
		await git(remote, "branch", "-D", "squashed");
		await git(local, "fetch", "-q", "--prune", "origin");
		// An upstream that is a local branch, which no remote listing holds.
		await git(local, "checkout", "-q", "-b", "follows", "main");
		await git(local, "branch", "-q", "--set-upstream-to=main", "follows");
		const { exec: counted, calls } = recording();

		const branches = await createGitHistory({ exec: counted }).branches(
			local,
			"main",
		);

		expect(branches.find((b) => b.name === "squashed")).toMatchObject({
			remoteGone: true,
		});
		expect(branches.find((b) => b.name === "follows")).toMatchObject({
			tracking: "main",
		});
		expect(
			branches.find((b) => b.name === "follows")?.remoteGone,
		).toBeUndefined();
		expect(calls.flat().filter((arg) => arg.includes(":track"))).toEqual([]);
	});

	it("asks once whether a ref holds the detached trees' commits, however many there are", async () => {
		const { local } = await repoWithRemote();
		for (const name of ["one", "two", "three"]) {
			await git(
				local,
				"worktree",
				"add",
				"-q",
				"--detach",
				`${local}/.wt/${name}`,
			);
			await git(
				`${local}/.wt/${name}`,
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				name,
			);
		}
		await git(local, "worktree", "add", "-q", "--detach", `${local}/.wt/read`);
		const { exec: counted, calls } = recording();

		const trees = await createGitHistory({ exec: counted }).worktrees(
			local,
			"main",
		);

		const kept = (name: string) =>
			trees.find((t) => t.path.endsWith(`/${name}`))?.commitKept;
		expect(["one", "two", "three", "read"].map(kept)).toEqual([
			undefined,
			undefined,
			undefined,
			true,
		]);
		const asked = calls.filter((args) =>
			args.some((arg) => arg === "rev-list" || arg.startsWith("--contains")),
		);
		expect(asked).toHaveLength(1);
	});

	it("asks nothing of a tree the caller already keeps", async () => {
		const { local } = await repoWithRemote();
		await git(local, "worktree", "add", "-q", "--detach", `${local}/.wt/held`);
		await writeFile(`${local}/.wt/held/scratch.txt`, "not committed");
		await git(local, "worktree", "add", "-q", "--detach", `${local}/.wt/free`);
		const held = realpathSync(`${local}/.wt/held`);
		const { exec: counted, calls } = recording();

		const trees = await createGitHistory({ exec: counted }).worktrees(
			local,
			"main",
			{ kept: (path) => realpathSync(path) === held },
		);

		expect(trees.map((t) => t.path).sort()).toEqual(
			[realpathSync(local), held, realpathSync(`${local}/.wt/free`)].sort(),
		);
		const askedOf = (path: string) =>
			calls.filter((args) => args[0] === "-C" && args[1] === path).length;
		expect(askedOf(`${local}/.wt/held`) + askedOf(held)).toBe(0);
		expect(trees.find((t) => t.path === held)?.dirty).toBeUndefined();
		expect(trees.find((t) => t.path.endsWith("/free"))).toMatchObject({
			commitKept: true,
		});
	});

	// One World tree took 733 s to answer its status, and the survey of
	// every other tree waited on it. Its clock stops it, as the caller's
	// exec is told to, and that one tree is kept rather than guessed at.
	it("keeps a tree whose status ran out of time, and reads the rest", async () => {
		const { local } = await repoWithRemote();
		for (const name of ["spent", "slow"]) {
			await git(local, "branch", name, "main");
			await git(local, "worktree", "add", "-q", `${local}/.wt/${name}`, name);
		}
		const slow = realpathSync(`${local}/.wt/slow`);
		const statusExec: typeof exec = (command, args) =>
			args[1] !== undefined && realpathSync(args[1]) === slow
				? Promise.resolve({ code: EXIT_TIMED_OUT, stdout: "", stderr: "" })
				: exec(command, args);

		const plan = orphanedTrees({
			mainPath: realpathSync(local),
			worktrees: await createGitHistory({ exec }).worktrees(local, "main", {
				statusExec,
			}),
			remembered: [],
		});

		expect(plan.reclaimable).toEqual([
			{ path: realpathSync(`${local}/.wt/spent`), branch: "spent" },
		]);
		expect(plan.retained.find((t) => t.path === slow)?.why).toContain(
			"didn't say",
		);
	});
});
