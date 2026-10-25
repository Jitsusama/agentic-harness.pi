import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
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
	isMainWorkingTree,
	isTracked,
	isWithin,
	trackedTreeRoot,
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
	// The machine's own config signs every commit; a fixture's seed is not one.
	run(["config", "commit.gpgsign", "false"]);
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

	it("answers for the repository root itself", () => {
		// The path most callers have. Resolving an existing directory to
		// its parent puts the question outside the repository exactly when
		// the directory is its root, so this answered null for the one
		// input a caller is most likely to hold.
		const root = gitTreeRootOf(repo);

		expect(root && path.basename(root)).toBe(path.basename(repo));
	});

	it("answers for a directory inside the tree", () => {
		const root = gitTreeRootOf(path.join(repo, "src"));

		expect(root && path.basename(root)).toBe(path.basename(repo));
	});

	it("still answers when given a path that does not exist yet", () => {
		// Callers probe with a name they invent, which is how the two that
		// knew about this worked around it. That has to keep working.
		const root = gitTreeRootOf(path.join(repo, ".probe-that-is-not-there"));

		expect(root && path.basename(root)).toBe(path.basename(repo));
	});

	it("returns null for a directory outside any repository", () => {
		expect(gitTreeRootOf(outside)).toBeNull();
	});
});

describe("trackedTreeRoot", () => {
	/** A git lookup that counts how often it is asked. */
	function counting(answer: string | null) {
		const asked: string[] = [];
		return {
			asked,
			rootOf: (p: string) => {
				asked.push(p);
				return answer;
			},
		};
	}

	it("takes a tree holding a .git entry as its own root without asking git", () => {
		// Asked of every tracked tree on every write, once per tree: a quest
		// tracking 87 trees ran 87 git processes on pi's input path per write.
		const git = counting("/somewhere/else");

		expect(trackedTreeRoot(repo, git.rootOf)).toBe(realpathSync(repo));
		expect(git.asked).toEqual([]);
	});

	it("takes a linked worktree, whose .git is a file, as its own root too", () => {
		const linked = mkdtempSync(path.join(tmpdir(), "tracked-root-linked-"));
		writeFileSync(path.join(linked, ".git"), "gitdir: /elsewhere\n");
		const git = counting(null);
		try {
			expect(trackedTreeRoot(linked, git.rootOf)).toBe(realpathSync(linked));
			expect(git.asked).toEqual([]);
		} finally {
			rmSync(linked, { recursive: true, force: true });
		}
	});

	it("asks git for a tracked directory inside a tree", () => {
		const git = counting(repo);

		expect(trackedTreeRoot(path.join(repo, "src"), git.rootOf)).toBe(
			realpathSync(repo),
		);
		expect(git.asked).toEqual([path.join(repo, "src")]);
	});

	it("keeps the path itself when git has no root for it", () => {
		expect(trackedTreeRoot(outside, counting(null).rootOf)).toBe(
			realpathSync(outside),
		);
	});

	it("answers as git does, with git really asked", () => {
		expect(trackedTreeRoot(path.join(repo, "src"))).toBe(realpathSync(repo));
		expect(trackedTreeRoot(repo)).toBe(gitTreeRootOf(repo));
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

describe("isMainWorkingTree", () => {
	it("is true for a repository's primary checkout", () => {
		expect(isMainWorkingTree(repo)).toBe(true);
		expect(isMainWorkingTree(path.join(repo, "src"))).toBe(true);
	});

	it("is false for a linked worktree", () => {
		const linked = mkdtempSync(path.join(tmpdir(), "git-signals-linked-"));
		const worktree = path.join(linked, "wt");
		execFileSync("git", ["worktree", "add", "-q", worktree], {
			cwd: repo,
			stdio: "ignore",
		});
		try {
			expect(isMainWorkingTree(worktree)).toBe(false);
		} finally {
			execFileSync("git", ["worktree", "remove", "--force", worktree], {
				cwd: repo,
				stdio: "ignore",
			});
			rmSync(linked, { recursive: true, force: true });
		}
	});

	it("is false outside a repository", () => {
		expect(isMainWorkingTree(outside)).toBe(false);
	});
});
