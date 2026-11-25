/**
 * Releasing a tree takes its branch with it once trunk has it.
 *
 * core.nix's checkout held 5,734 local branches and 4,691 `[branch]`
 * sections in its config, 518 KB, nearly all from agents' released
 * trees, and every git read of that config paid for it. These run real
 * git, since what matters is what git is left holding.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import {
	dropMergedBranch,
	mergedPullHeads,
} from "../../../lib/core/work/merged-branch.ts";
import { createGitTreeProvider } from "../../../lib/core/work/providers/git.ts";
import { reclaimTrees } from "../../../lib/core/work/reclaim.ts";
import { type TreeRequest, treeIdentity } from "../../../lib/core/work/tree.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

/** Real git, answering as the work layer's exec does. */
const exec: Exec = async (command, args) => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	try {
		const { stdout, stderr } = await promisify(execFile)(command, [...args]);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
		};
	}
};

let origin: string;
let checkout: string;
let trees: string;

beforeEach(async () => {
	origin = await freshRepo("release-origin");
	// The origin keeps trunk checked out, so a push to it lands on a
	// branch beside it rather than being refused.
	checkout = mkdtempSync(join(tmpdir(), "release-checkout-"));
	await git(checkout, "clone", "-q", origin, ".");
	await git(checkout, "config", "user.email", "test@example.com");
	await git(checkout, "config", "user.name", "Test");
	await git(checkout, "config", "commit.gpgsign", "false");
	trees = mkdtempSync(join(tmpdir(), "release-trees-"));
});

afterEach(() => {
	rmSync(trees, { recursive: true, force: true });
	disposeRepo(checkout);
	disposeRepo(origin);
});

const request = (branch: string): TreeRequest => ({
	intent: "worktree",
	repo: { key: "github:jg/scratch", localPath: checkout },
	purpose: branch,
	branch,
});

/** Cut a tree on `branch`, commit in it, and push it with its upstream. */
async function workOn(branch: string): Promise<string> {
	const provider = createGitTreeProvider({
		exec,
		stateDir: trees,
		subvolumes: async () => false,
	});
	const { path } = await provider.ensure(request(branch));
	writeFileSync(join(path, `${branch.replace("/", "-")}.md`), "done\n");
	await git(path, "add", ".");
	await git(path, "commit", "-qm", `work on ${branch}`);
	await git(path, "push", "-q", "-u", "origin", branch);
	return path;
}

/** Merge `branch` into origin's trunk, and fetch it here. */
async function mergeOnOrigin(branch: string): Promise<void> {
	await git(origin, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);
	await git(checkout, "fetch", "-q", "origin");
}

async function release(branch: string, path: string): Promise<void> {
	const provider = createGitTreeProvider({
		exec,
		stateDir: trees,
		subvolumes: async () => false,
	});
	await provider.release({
		identity: treeIdentity(request(branch)),
		path,
		providerId: provider.id,
	});
}

const hasRef = async (branch: string) =>
	(
		await exec("git", [
			"-C",
			checkout,
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/heads/${branch}`,
		])
	).code === 0;
/**
 * The config keys set under `branch`'s section, or "" when there are
 * none. Any answer from git but "no key matched" throws, so a broken
 * query can't pass for an empty section.
 */
const sections = async (branch: string) => {
	const answer = await exec("git", [
		"-C",
		checkout,
		"config",
		"--get-regexp",
		`^branch\\.${branch.replaceAll("/", "\\/").replaceAll(".", "\\.")}\\.`,
	]);
	if (answer.code === 1) return "";
	if (answer.code !== 0) throw new Error(`git config said ${answer.stderr}`);
	return answer.stdout.trim();
};

/** Point origin/HEAD at `ref`, by hand, as a rename or a person might. */
const originHeadAt = (ref: string) =>
	git(checkout, "symbolic-ref", "refs/remotes/origin/HEAD", ref);

describe("releasing a tree", () => {
	it("leaves no ref and no config section for a branch trunk has merged", async () => {
		const path = await workOn("jg/done");
		await mergeOnOrigin("jg/done");
		expect(await sections("jg/done")).not.toBe("");

		await release("jg/done", path);

		expect(await hasRef("jg/done"), "the merged branch is gone").toBe(false);
		expect(await sections("jg/done")).toBe("");
	});

	it("keeps a pushed branch whose commits trunk lacks", async () => {
		const path = await workOn("jg/open");

		await release("jg/open", path);

		expect(await hasRef("jg/open"), "the unmerged branch is kept").toBe(true);
		expect(await sections("jg/open")).not.toBe("");
	});

	it("keeps a branch nobody pushed", async () => {
		const provider = createGitTreeProvider({
			exec,
			stateDir: trees,
			subvolumes: async () => false,
		});
		const { path } = await provider.ensure(request("jg/local"));
		writeFileSync(join(path, "local.md"), "only here\n");
		await git(path, "add", ".");
		await git(path, "commit", "-qm", "only here");

		await release("jg/local", path);

		expect(await hasRef("jg/local"), "the unpushed branch is kept").toBe(true);
	});

	it("judges by origin/main when origin/HEAD is not set", async () => {
		const path = await workOn("jg/nohead");
		await mergeOnOrigin("jg/nohead");
		await git(checkout, "remote", "set-head", "origin", "-d");

		await release("jg/nohead", path);

		expect(await hasRef("jg/nohead"), "the merged branch is gone").toBe(false);
	});

	it("judges by origin/main when origin/HEAD names a branch that is gone", async () => {
		const path = await workOn("jg/renamed");
		await mergeOnOrigin("jg/renamed");
		await originHeadAt("refs/remotes/origin/master");

		await release("jg/renamed", path);

		expect(await hasRef("jg/renamed"), "the merged branch is gone").toBe(false);
	});

	it("never judges by a local branch origin/HEAD was pointed at", async () => {
		const path = await workOn("jg/unlanded");
		// A local branch holding the work, which origin's trunk does not.
		await git(checkout, "branch", "jg/local-trunk", "jg/unlanded");
		await originHeadAt("refs/heads/jg/local-trunk");

		await release("jg/unlanded", path);

		expect(
			await hasRef("jg/unlanded"),
			"the branch origin's trunk lacks is kept",
		).toBe(true);
	});

	it("takes a merged branch that shares its name with a tag", async () => {
		const path = await workOn("jg/tagged");
		await mergeOnOrigin("jg/tagged");
		// Its short name is now heads/jg/tagged, which is not the branch.
		// Written as a ref, since a person's config may sign every tag.
		await git(checkout, "update-ref", "refs/tags/jg/tagged", "main");

		await release("jg/tagged", path);

		expect(await hasRef("jg/tagged"), "the merged branch is gone").toBe(false);
	});

	it("keeps a merged branch another branch is stacked on", async () => {
		const path = await workOn("jg/base");
		await mergeOnOrigin("jg/base");
		await git(checkout, "branch", "jg/child", "jg/base");
		await git(checkout, "config", "branch.jg/child.workparent", "jg/base");

		await release("jg/base", path);

		expect(
			await hasRef("jg/base"),
			"the branch a stack names as parent is kept",
		).toBe(true);
	});

	it("keeps a merged branch that has gained a commit nobody pushed", async () => {
		const path = await workOn("jg/more");
		await mergeOnOrigin("jg/more");
		writeFileSync(join(path, "more.md"), "after the merge\n");
		await git(path, "add", ".");
		await git(path, "commit", "-qm", "more");

		await release("jg/more", path);

		expect(
			await hasRef("jg/more"),
			"the branch with an unpushed commit is kept",
		).toBe(true);
	});

	it("touches no branch for a tree that stood on none", async () => {
		const path = await workOn("jg/kept");
		await mergeOnOrigin("jg/kept");
		// Left for a bare commit, as a snapshot stands: the branch it was
		// cut on is no longer this tree's to take.
		await git(path, "checkout", "-q", "--detach");

		await release("jg/kept", path);

		expect(await hasRef("jg/kept"), "a branch no tree stood on is kept").toBe(
			true,
		);
	});
});

describe("dropping a merged branch", () => {
	it("keeps trunk's own branch, merged though it is", async () => {
		// Detached, so no checkout has main out and git itself would let
		// it go: only the trunk's-name rule keeps it.
		await git(checkout, "checkout", "-q", "--detach");

		const gone = await dropMergedBranch(exec, checkout, "main");

		expect(gone, "dropMergedBranch answers that main stayed").toBe(false);
		expect(await hasRef("main"), "main is kept").toBe(true);
	});

	it("keeps a merged branch a checkout still has out", async () => {
		await workOn("jg/busy");
		await mergeOnOrigin("jg/busy");

		const gone = await dropMergedBranch(exec, checkout, "jg/busy");

		expect(gone, "git refused, so it answers the branch stayed").toBe(false);
		expect(await hasRef("jg/busy"), "the branch out in a tree is kept").toBe(
			true,
		);
	});
});

describe("reclaiming a tree", () => {
	it("leaves no ref and no config section for a branch trunk has merged", async () => {
		const path = await workOn("jg/spent");
		await mergeOnOrigin("jg/spent");

		const outcome = await reclaimTrees({ exec, mainPath: checkout }, [
			{ path, branch: "jg/spent" },
		]);

		expect(outcome.trees[0]).toEqual({
			kind: "reclaimed",
			path,
			branch: "jg/spent",
			branchGone: true,
		});
		expect(await hasRef("jg/spent"), "the merged branch is gone").toBe(false);
		expect(await sections("jg/spent")).toBe("");
	});

	it("keeps a branch whose commits trunk lacks", async () => {
		const path = await workOn("jg/unmerged");

		const outcome = await reclaimTrees({ exec, mainPath: checkout }, [
			{ path, branch: "jg/unmerged" },
		]);

		expect(outcome.trees[0]).toEqual({
			kind: "reclaimed",
			path,
			branch: "jg/unmerged",
		});
		expect(await hasRef("jg/unmerged"), "the unmerged branch is kept").toBe(
			true,
		);
		expect(await sections("jg/unmerged")).not.toBe("");
	});
});

describe("the heads a forge merged", () => {
	/** An exec answering git's origin with `origin` and gh with `listed`. */
	const answering =
		(
			origin: string,
			listed: { code: number; stdout: string },
			asked: string[][] = [],
		): Exec =>
		async (command, args) => {
			asked.push([command, ...args]);
			if (command === "git") {
				return { code: 0, stdout: `${origin}\n`, stderr: "" };
			}
			return { ...listed, stderr: "" };
		};
	const two = {
		code: 0,
		stdout: JSON.stringify([
			{ number: 12, headRefOid: "a".repeat(40) },
			{ number: 11, headRefOid: "b".repeat(40) },
		]),
	};

	it("lists a GitHub origin's merged pull requests once, by head", async () => {
		for (const origin of [
			"https://github.com/owner/repo.git",
			"git@github.com:owner/repo.git",
			"ssh://git@github.com/owner/repo",
		]) {
			const asked: string[][] = [];
			const heads = await mergedPullHeads(
				answering(origin, two, asked),
				"/checkout",
			);
			expect(heads, origin).toEqual(
				new Map([
					["a".repeat(40), 12],
					["b".repeat(40), 11],
				]),
			);
			const listings = asked.filter(([command]) => command === "gh");
			expect(listings, origin).toHaveLength(1);
			expect(listings[0], origin).toEqual(
				expect.arrayContaining(["--repo", "owner/repo", "merged"]),
			);
		}
	});

	it("says nothing for another forge, a failed listing or one it can't read", async () => {
		const asked: string[][] = [];
		expect(
			await mergedPullHeads(
				answering("/srv/git/repo", two, asked),
				"/checkout",
			),
		).toBeUndefined();
		expect(
			asked.some(([command]) => command === "gh"),
			"another forge is never asked of GitHub",
		).toBe(false);
		const origin = "https://github.com/owner/repo";
		expect(
			await mergedPullHeads(
				answering(origin, { code: 1, stdout: "" }),
				"/checkout",
			),
		).toBeUndefined();
		expect(
			await mergedPullHeads(
				answering(origin, { code: 0, stdout: "not json" }),
				"/checkout",
			),
		).toBeUndefined();
		expect(
			await mergedPullHeads(
				answering(origin, {
					code: 0,
					stdout: JSON.stringify([{ number: "12", headRefOid: 4 }]),
				}),
				"/checkout",
			),
			"an entry without a number and a head names nothing",
		).toEqual(new Map());
	});
});
