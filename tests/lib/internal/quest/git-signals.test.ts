import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	gitTreeRootOf,
	isGitignored,
	isMainWorkingTree,
	isTracked,
	isWithin,
	trackedTreeRoot,
	treeRootOf,
} from "../../../../lib/internal/quest/git-signals.ts";
import { SANDBOX_VARIABLE } from "../../../../lib/internal/sandbox.ts";

let repo: string;
let outside: string;

beforeAll(() => {
	// Unfenced, whatever runs the tests: inside the fence git is refused in
	// a repo that isn't a cut tree, which these fixtures never are, so a
	// fenced session read every answer as none.
	vi.stubEnv(SANDBOX_VARIABLE, "");
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
		expect(isWithin("/a/feat", "/a/feat"), "/a/feat is within itself").toBe(
			true,
		);
		expect(
			isWithin("/a/feat/x/y", "/a/feat"),
			"/a/feat/x/y is within /a/feat",
		).toBe(true);
	});

	it("rejects a sibling whose name shares a prefix", () => {
		expect(
			isWithin("/a/feature-2/x", "/a/feat"),
			"/a/feature-2/x is not within /a/feat, whose name it only begins with",
		).toBe(false);
	});

	it("canonicalizes both sides so a symlinked path still matches", () => {
		const real = mkdtempSync(path.join(tmpdir(), "within-real-"));
		const link = `${real}-link`;
		symlinkSync(real, link);
		mkdirSync(path.join(real, "w"));
		try {
			expect(
				isWithin(path.join(link, "w", "f.ts"), path.join(real, "w")),
				`${link}/w/f.ts is within ${real}/w through the link`,
			).toBe(true);
		} finally {
			rmSync(link, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});
});

afterAll(() => {
	vi.unstubAllEnvs();
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
			rootOf: async (p: string) => {
				asked.push(p);
				return answer;
			},
		};
	}

	it("takes a tree holding a .git entry as its own root without asking git", async () => {
		// Asked of every tracked tree on every write, once per tree: a quest
		// tracking 87 trees ran 87 git processes on pi's input path per write.
		const git = counting("/somewhere/else");

		expect(await trackedTreeRoot(repo, git.rootOf)).toBe(realpathSync(repo));
		expect(git.asked).toEqual([]);
	});

	it("takes a linked worktree, whose .git is a file, as its own root too", async () => {
		const linked = mkdtempSync(path.join(tmpdir(), "tracked-root-linked-"));
		writeFileSync(path.join(linked, ".git"), "gitdir: /elsewhere\n");
		const git = counting(null);
		try {
			expect(await trackedTreeRoot(linked, git.rootOf)).toBe(
				realpathSync(linked),
			);
			expect(git.asked).toEqual([]);
		} finally {
			rmSync(linked, { recursive: true, force: true });
		}
	});

	it("asks git for a tracked directory inside a tree", async () => {
		const git = counting(repo);

		expect(await trackedTreeRoot(path.join(repo, "src"), git.rootOf)).toBe(
			realpathSync(repo),
		);
		expect(git.asked).toEqual([path.join(repo, "src")]);
	});

	it("keeps the path itself when git has no root for it", async () => {
		expect(await trackedTreeRoot(outside, counting(null).rootOf)).toBe(
			realpathSync(outside),
		);
	});

	it("answers as git does, with git really asked", async () => {
		expect(await trackedTreeRoot(path.join(repo, "src"))).toBe(
			realpathSync(repo),
		);
		expect(await trackedTreeRoot(repo)).toBe(gitTreeRootOf(repo));
	});
});

describe("treeRootOf", () => {
	it("answers as gitTreeRootOf does", async () => {
		for (const asked of [
			repo,
			path.join(repo, "src"),
			path.join(repo, "src", "new.ts"),
			outside,
			path.join(outside, "loose.ts"),
		]) {
			expect(await treeRootOf(asked), asked).toBe(gitTreeRootOf(asked));
		}
	});
});

describe("isGitignored", () => {
	it("is true for an ignored path", async () => {
		expect(
			await isGitignored(path.join(repo, "build.log")),
			"build.log is ignored by *.log",
		).toBe(true);
		expect(
			await isGitignored(path.join(repo, "ignored", "x.ts")),
			"ignored/x.ts is ignored by ignored/",
		).toBe(true);
	});

	it("is false for a tracked or merely untracked path", async () => {
		expect(
			await isGitignored(path.join(repo, "src", "tracked.ts")),
			"the tracked src/tracked.ts is not ignored",
		).toBe(false);
		expect(
			await isGitignored(path.join(repo, "src", "brand-new.ts")),
			"the untracked src/brand-new.ts is not ignored",
		).toBe(false);
	});

	it("is false outside a repository", async () => {
		expect(
			await isGitignored(path.join(outside, "x.log")),
			`${outside}/x.log, in no repository, is not ignored`,
		).toBe(false);
	});
});

describe("isTracked", () => {
	it("is true for a committed path", async () => {
		expect(
			await isTracked(path.join(repo, "src", "tracked.ts")),
			"the committed src/tracked.ts is tracked",
		).toBe(true);
	});

	it("is false for a new untracked path", async () => {
		expect(
			await isTracked(path.join(repo, "src", "brand-new.ts")),
			"the new src/brand-new.ts is not tracked",
		).toBe(false);
	});

	it("is false outside a repository", async () => {
		expect(
			await isTracked(path.join(outside, "x.ts")),
			`${outside}/x.ts, in no repository, is not tracked`,
		).toBe(false);
	});
});

// The write gate and the shell-habit interceptor ask these of every
// write, on the loop a host runs every conversation on, where a git
// started with execFileSync held all of them until it answered. A fake
// git stands in: one that notes it ran, and takes its time to answer.
describe("asking git of a write's target", () => {
	let bin: string;
	let ran: string;
	let checkout: string;
	let saved: string | undefined;

	beforeEach(() => {
		bin = mkdtempSync(path.join(tmpdir(), "git-signals-bin-"));
		ran = path.join(bin, "ran");
		const git = path.join(bin, "git");
		writeFileSync(git, `#!/bin/sh\necho ran >> ${ran}\nsleep 0.3\nexit 0\n`);
		chmodSync(git, 0o755);
		checkout = mkdtempSync(path.join(tmpdir(), "git-signals-checkout-"));
		mkdirSync(path.join(checkout, ".git"));
		saved = process.env.PATH;
		process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
	});

	afterEach(() => {
		process.env.PATH = saved;
		rmSync(bin, { recursive: true, force: true });
		rmSync(checkout, { recursive: true, force: true });
	});

	it("starts no git for a target with no checkout above it", async () => {
		const loose = path.join(outside, "x.log");

		await isTracked(loose);
		await isGitignored(loose);
		await treeRootOf(loose);

		expect(existsSync(ran), "a git was started").toBe(false);
	});

	it("leaves the loop free while git answers", async () => {
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		const tracked = await isTracked(path.join(checkout, "a.ts"));

		expect(existsSync(ran), "git was asked").toBe(true);
		expect(turned, "the loop turned while git answered").toBe(true);
		expect(tracked, "git's answer").toBe(true);
	});
});

describe("isMainWorkingTree", () => {
	it("is true for a repository's primary checkout", () => {
		expect(
			isMainWorkingTree(repo),
			`${repo} is its repository's primary checkout`,
		).toBe(true);
		expect(
			isMainWorkingTree(path.join(repo, "src")),
			`${repo}/src is inside the primary checkout`,
		).toBe(true);
	});

	it("is false for a linked worktree", () => {
		const linked = mkdtempSync(path.join(tmpdir(), "git-signals-linked-"));
		const worktree = path.join(linked, "wt");
		execFileSync("git", ["worktree", "add", "-q", worktree], {
			cwd: repo,
			stdio: "ignore",
		});
		try {
			expect(
				isMainWorkingTree(worktree),
				`the linked worktree ${worktree} is not the primary checkout`,
			).toBe(false);
		} finally {
			execFileSync("git", ["worktree", "remove", "--force", worktree], {
				cwd: repo,
				stdio: "ignore",
			});
			rmSync(linked, { recursive: true, force: true });
		}
	});

	it("is false outside a repository", () => {
		expect(
			isMainWorkingTree(outside),
			`${outside}, in no repository, is no checkout`,
		).toBe(false);
	});
});
