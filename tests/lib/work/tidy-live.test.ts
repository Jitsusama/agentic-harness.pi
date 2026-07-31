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
import { afterEach, describe, expect, it } from "vitest";
import { createGitHistory, tidyPlan } from "../../../lib/work/index.js";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.js";

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

		expect(branches.find((b) => b.name === "landed")?.mergedIntoTrunk).toBe(
			true,
		);
	});

	it("does not call an unmerged branch merged", async () => {
		const { local } = await repoWithRemote();
		await publishBranch(local, "wip");
		await git(local, "checkout", "-q", "main");

		const branches = await createGitHistory({ exec }).branches(local, "main");

		expect(branches.find((b) => b.name === "wip")?.mergedIntoTrunk).toBe(false);
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

		expect(squashed?.remoteGone).toBe(true);
		expect(squashed?.mergedIntoTrunk).toBe(false);
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
		expect(plan.keeping.find((k) => k.branch === "squashed")?.decide).toBe(
			true,
		);
		expect(plan.prunable).toBe(true);
	});
});
