import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitWorktreeProvider } from "../../../lib/internal/tree/providers/git-worktree";

const execFileAsync = promisify(execFile);

let repoRoot: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.toString();
}

async function makeRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "tree-test-"));
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	writeFileSync(join(dir, "README.md"), "scratch repo\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-qm", "initial");
	return dir;
}

beforeEach(async () => {
	repoRoot = await makeRepo();
});

afterEach(() => {
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
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
});
