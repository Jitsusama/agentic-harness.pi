import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	gitTreeRootOf,
	isGitignored,
	isTracked,
	isWithin,
} from "../../../../lib/internal/quest/git-signals";

let repo: string;
let outside: string;

beforeAll(() => {
	repo = mkdtempSync(path.join(tmpdir(), "git-signals-repo-"));
	outside = mkdtempSync(path.join(tmpdir(), "git-signals-outside-"));
	const run = (args: string[]) =>
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	run(["init", "-q"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	writeFileSync(path.join(repo, ".gitignore"), "ignored/\n*.log\n");
	mkdirSync(path.join(repo, "src"));
	writeFileSync(path.join(repo, "src", "tracked.ts"), "export const a = 1;\n");
	run(["add", "src/tracked.ts", ".gitignore"]);
	run(["commit", "-q", "-m", "seed"]);
});

describe("isWithin", () => {
	it("matches a path that is the parent or under it", () => {
		expect(isWithin("/a/feat", "/a/feat")).toBe(true);
		expect(isWithin("/a/feat/x/y", "/a/feat")).toBe(true);
	});

	it("rejects a sibling whose name shares a prefix", () => {
		expect(isWithin("/a/feature-2/x", "/a/feat")).toBe(false);
	});

	it("canonicalizes both sides so a symlinked path still matches", () => {
		const real = mkdtempSync(path.join(tmpdir(), "within-real-"));
		const link = `${real}-link`;
		symlinkSync(real, link);
		mkdirSync(path.join(real, "w"));
		try {
			expect(isWithin(path.join(link, "w", "f.ts"), path.join(real, "w"))).toBe(
				true,
			);
		} finally {
			rmSync(link, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe("gitTreeRootOf", () => {
	it("returns the repo root for a path inside the tree", () => {
		const root = gitTreeRootOf(path.join(repo, "src", "new.ts"));
		// macOS temp dirs canonicalize through /private; compare basenames.
		expect(root && path.basename(root)).toBe(path.basename(repo));
	});

	it("returns null for a path outside any repository", () => {
		expect(gitTreeRootOf(path.join(outside, "loose.ts"))).toBeNull();
	});
});

describe("isGitignored", () => {
	it("is true for an ignored path", () => {
		expect(isGitignored(path.join(repo, "build.log"))).toBe(true);
		expect(isGitignored(path.join(repo, "ignored", "x.ts"))).toBe(true);
	});

	it("is false for a tracked or merely untracked path", () => {
		expect(isGitignored(path.join(repo, "src", "tracked.ts"))).toBe(false);
		expect(isGitignored(path.join(repo, "src", "brand-new.ts"))).toBe(false);
	});

	it("is false outside a repository", () => {
		expect(isGitignored(path.join(outside, "x.log"))).toBe(false);
	});
});

describe("isTracked", () => {
	it("is true for a committed path", () => {
		expect(isTracked(path.join(repo, "src", "tracked.ts"))).toBe(true);
	});

	it("is false for a new untracked path", () => {
		expect(isTracked(path.join(repo, "src", "brand-new.ts"))).toBe(false);
	});

	it("is false outside a repository", () => {
		expect(isTracked(path.join(outside, "x.ts"))).toBe(false);
	});
});
