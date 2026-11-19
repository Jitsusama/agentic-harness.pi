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
	(await exec("git", ["-C", checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))
		.code === 0;
const sections = async (branch: string) =>
	(
		await exec("git", [
			"-C",
			checkout,
			"config",
			"--get-regexp",
			`^branch\\.${branch.replace("/", "\\/")}\\.`,
		])
	).stdout.trim();

describe("releasing a tree", () => {
	it("leaves no ref and no config section for a branch trunk has merged", async () => {
		const path = await workOn("jg/done");
		await mergeOnOrigin("jg/done");
		expect(await sections("jg/done")).not.toBe("");

		await release("jg/done", path);

		expect(await hasRef("jg/done")).toBe(false);
		expect(await sections("jg/done")).toBe("");
	});

	it("keeps a branch whose commits trunk lacks, pushed or not", async () => {
		const path = await workOn("jg/open");

		await release("jg/open", path);

		expect(await hasRef("jg/open")).toBe(true);
		expect(await sections("jg/open")).not.toBe("");
	});

	it("keeps a merged branch that has gained a commit nobody pushed", async () => {
		const path = await workOn("jg/more");
		await mergeOnOrigin("jg/more");
		writeFileSync(join(path, "more.md"), "after the merge\n");
		await git(path, "add", ".");
		await git(path, "commit", "-qm", "more");

		await release("jg/more", path);

		expect(await hasRef("jg/more")).toBe(true);
	});

	it("touches no branch for a tree that stood on none", async () => {
		const path = await workOn("jg/kept");
		await mergeOnOrigin("jg/kept");
		// Left for a bare commit, as a snapshot stands: the branch it was
		// cut on is no longer this tree's to take.
		await git(path, "checkout", "-q", "--detach");

		await release("jg/kept", path);

		expect(await hasRef("jg/kept")).toBe(true);
	});
});

describe("reclaiming a tree", () => {
	it("leaves no ref and no config section for a branch trunk has merged", async () => {
		const path = await workOn("jg/spent");
		await mergeOnOrigin("jg/spent");

		const outcome = await reclaimTrees({ exec, mainPath: checkout }, [
			{ path, branch: "jg/spent" },
		]);

		expect(outcome.trees[0]?.kind).toBe("reclaimed");
		expect(await hasRef("jg/spent")).toBe(false);
		expect(await sections("jg/spent")).toBe("");
	});

	it("keeps a branch whose commits trunk lacks", async () => {
		const path = await workOn("jg/unmerged");

		await reclaimTrees({ exec, mainPath: checkout }, [
			{ path, branch: "jg/unmerged" },
		]);

		expect(await hasRef("jg/unmerged")).toBe(true);
	});
});
