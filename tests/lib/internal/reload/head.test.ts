/**
 * A checkout's HEAD read from git's own files agrees with what git says,
 * for a branch in its own file or packed, a detached HEAD and a worktree.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { headFromFiles } from "../../../../lib/internal/reload/head.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";

describe("reading HEAD from git's files", () => {
	let repo: string | undefined;
	const made: string[] = [];
	afterEach(() => {
		if (repo) disposeRepo(repo);
		repo = undefined;
		for (const dir of made.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	let commits = 0;
	async function committed(where: string): Promise<string> {
		commits++;
		writeFileSync(join(where, `file-${commits}`), "x");
		await git(where, "add", "-A");
		await git(where, "commit", "-qm", `commit ${commits}`);
		return git(where, "rev-parse", "HEAD");
	}

	it("follows a branch's own file", async () => {
		repo = await freshRepo();
		const head = await committed(repo);
		expect(headFromFiles(repo)).toBe(head);
	});

	it("follows a branch packed into packed-refs", async () => {
		repo = await freshRepo();
		const head = await committed(repo);
		await git(repo, "pack-refs", "--all");
		expect(headFromFiles(repo)).toBe(head);
	});

	it("reads a detached HEAD", async () => {
		repo = await freshRepo();
		const head = await committed(repo);
		await git(repo, "checkout", "-q", "--detach");
		expect(headFromFiles(repo)).toBe(head);
	});

	it("reads a worktree's HEAD through its .git file", async () => {
		repo = await freshRepo();
		const parent = mkdtempSync(join(tmpdir(), "head-tree-"));
		made.push(parent);
		const tree = join(parent, "tree");
		await git(repo, "worktree", "add", "-q", "-b", "side", tree);
		const head = await committed(tree);
		expect(headFromFiles(tree)).toBe(head);
		expect(headFromFiles(repo), "the main tree's own HEAD").toBe(
			await git(repo, "rev-parse", "HEAD"),
		);
	});

	it("says nothing where there is no checkout", () => {
		const dir = mkdtempSync(join(tmpdir(), "head-none-"));
		made.push(dir);
		expect(headFromFiles(dir)).toBeUndefined();
	});
});
