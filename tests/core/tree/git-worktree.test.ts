import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitWorktreeProvider } from "../../../lib/core/internal/tree/providers/git-worktree.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let repoRoot: string;

beforeEach(async () => {
	repoRoot = await freshRepo("tree-test");
});

afterEach(() => {
	disposeRepo(repoRoot);
});

describe("git-worktree provider", () => {
	it("applies to directories with a .git entry", () => {
		const provider = createGitWorktreeProvider();
		expect(provider.appliesTo(repoRoot)).toBe(true);
		expect(provider.appliesTo("/tmp")).toBe(false);
	});

	it("creates a worktree at <repo>/.worktrees/<name> with a fresh branch", async () => {
		const provider = createGitWorktreeProvider();
		const handle = await provider.create({
			name: "feature-x",
			repoRoot,
		});
		expect(handle.path).toBe(join(repoRoot, ".worktrees", "feature-x"));
		expect(handle.branch).toBe("feature-x");
		expect(handle.providerId).toBe("git-worktree");
		expect(existsSync(handle.path)).toBe(true);
		const branch = (
			await git(handle.path, "rev-parse", "--abbrev-ref", "HEAD")
		).trim();
		expect(branch).toBe("feature-x");
	});

	it("adds .worktrees/ to gitignore on first create", async () => {
		const provider = createGitWorktreeProvider();
		await provider.create({ name: "feature-y", repoRoot });
		const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
		expect(ignore.split("\n")).toContain(".worktrees/");
	});

	it("refuses to create a second tree with the same name", async () => {
		const provider = createGitWorktreeProvider();
		await provider.create({ name: "dup", repoRoot });
		await expect(provider.create({ name: "dup", repoRoot })).rejects.toThrow(
			/already exists/,
		);
	});

	it("prunes a clean worktree and removes the branch", async () => {
		const provider = createGitWorktreeProvider();
		const handle = await provider.create({ name: "feature-z", repoRoot });
		await provider.prune({ path: handle.path });
		expect(existsSync(handle.path)).toBe(false);
		const branches = await git(repoRoot, "branch", "--list", "feature-z");
		expect(branches.trim()).toBe("");
	});

	it("refuses to prune a dirty worktree by default", async () => {
		const provider = createGitWorktreeProvider();
		const handle = await provider.create({ name: "dirty", repoRoot });
		writeFileSync(join(handle.path, "scratch.txt"), "dirty\n");
		await expect(provider.prune({ path: handle.path })).rejects.toThrow(
			/uncommitted/,
		);
		expect(existsSync(handle.path)).toBe(true);
	});

	it("force-prunes a dirty worktree", async () => {
		const provider = createGitWorktreeProvider();
		const handle = await provider.create({ name: "dirty-force", repoRoot });
		writeFileSync(join(handle.path, "scratch.txt"), "dirty\n");
		await provider.prune({ path: handle.path, force: true });
		expect(existsSync(handle.path)).toBe(false);
	});

	it("lists worktrees under a repo, excluding the main one", async () => {
		const provider = createGitWorktreeProvider();
		await provider.create({ name: "a", repoRoot });
		await provider.create({ name: "b", repoRoot });
		const handles = await provider.list?.(repoRoot);
		expect(handles?.map((h) => h.branch).sort()).toEqual(["a", "b"]);
	});

	it("refuses tree names containing path traversal or dash prefixes", async () => {
		const provider = createGitWorktreeProvider();
		await expect(
			provider.create({ name: "../escape", repoRoot }),
		).rejects.toThrow(/Tree name/);
		await expect(provider.create({ name: "-rf", repoRoot })).rejects.toThrow(
			/Tree name/,
		);
		await expect(provider.create({ name: "a/../b", repoRoot })).rejects.toThrow(
			/Tree name/,
		);
		await expect(provider.create({ name: "", repoRoot })).rejects.toThrow(
			/cannot be empty/,
		);
	});

	it("refuses base branches that try to slip in flags", async () => {
		const provider = createGitWorktreeProvider();
		await expect(
			provider.create({
				name: "safe-name",
				repoRoot,
				baseBranch: "-rf",
			}),
		).rejects.toThrow(/Base branch/);
	});

	it("compares against the local default branch when no origin remote exists", async () => {
		const provider = createGitWorktreeProvider();
		const handle = await provider.create({ name: "local-only", repoRoot });
		writeFileSync(join(handle.path, "commit-me.txt"), "unmerged work\n");
		await git(handle.path, "add", "commit-me.txt");
		await git(handle.path, "commit", "-qm", "unmerged commit");
		// No origin remote: previously this silently returned
		// false and let a non-force prune destroy the work.
		await expect(provider.prune({ path: handle.path })).rejects.toThrow(
			/not merged/,
		);
		expect(existsSync(handle.path)).toBe(true);
	});
});

describe("pruning a branch merged on the host", () => {
	let remote: string;
	let other: string;

	beforeEach(async () => {
		remote = mkdtempSync(join(tmpdir(), "tree-remote-"));
		await git(remote, "init", "-q", "--bare", "-b", "main");
		await git(repoRoot, "remote", "add", "origin", remote);
		await git(repoRoot, "push", "-q", "origin", "main");
		await git(repoRoot, "fetch", "-q", "origin");
		other = mkdtempSync(join(tmpdir(), "tree-other-"));
		await git(other, "clone", "-q", remote, ".");
		await git(other, "config", "user.email", "host@example.com");
		await git(other, "config", "user.name", "Host");
		await git(other, "config", "commit.gpgsign", "false");
	});

	afterEach(() => {
		rmSync(remote, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	});

	/** A tree with two commits, pushed as its own branch. */
	async function workedTree(name: string) {
		const provider = createGitWorktreeProvider();
		const handle = await provider.create({ name, repoRoot });
		for (const file of ["one.txt", "two.txt"]) {
			writeFileSync(join(handle.path, file), `${file}\n`);
			await git(handle.path, "add", file);
			await git(handle.path, "commit", "-qm", `add ${file}`);
		}
		await git(handle.path, "push", "-q", "origin", name);
		await git(other, "fetch", "-q", "origin");
		return { provider, handle };
	}

	/** Land the branch on the host's main, out of this checkout's sight. */
	async function landOnHost(name: string, how: "merge" | "squash") {
		if (how === "merge") {
			await git(
				other,
				"merge",
				"-q",
				"--no-ff",
				"-m",
				"merge",
				`origin/${name}`,
			);
		} else {
			await git(other, "merge", "-q", "--squash", `origin/${name}`);
			await git(other, "commit", "-qm", "squashed");
		}
		await git(other, "push", "-q", "origin", "main");
	}

	it("fetches main first, so a merge since the last fetch counts", async () => {
		const { provider, handle } = await workedTree("merged-there");
		await landOnHost("merged-there", "merge");

		await provider.prune({ path: handle.path });

		expect(existsSync(handle.path)).toBe(false);
	});

	it("counts a squash merge, and deletes the branch it leaves", async () => {
		const { provider, handle } = await workedTree("squashed-there");
		await landOnHost("squashed-there", "squash");

		await provider.prune({ path: handle.path });

		expect(existsSync(handle.path)).toBe(false);
		expect(await git(repoRoot, "branch", "--list", "squashed-there")).toBe("");
	});

	it("still refuses a branch whose work the host does not have", async () => {
		const { provider, handle } = await workedTree("not-there");

		await expect(provider.prune({ path: handle.path })).rejects.toThrow(
			/not merged against origin\/main/,
		);
		expect(existsSync(handle.path)).toBe(true);
	});

	it("still refuses when the host squashed only part of the work", async () => {
		const { provider, handle } = await workedTree("partly-there");
		writeFileSync(join(handle.path, "three.txt"), "three.txt\n");
		await git(handle.path, "add", "three.txt");
		await git(handle.path, "commit", "-qm", "add three.txt");
		await landOnHost("partly-there", "squash");

		await expect(provider.prune({ path: handle.path })).rejects.toThrow(
			/not merged/,
		);
	});

	it("judges against what it last saw when the host is unreachable", async () => {
		const { provider, handle } = await workedTree("offline");
		await landOnHost("offline", "merge");
		await git(repoRoot, "remote", "set-url", "origin", join(remote, "gone"));

		await expect(provider.prune({ path: handle.path })).rejects.toThrow(
			/not merged/,
		);
	});
});
