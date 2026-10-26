import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildPrepareCommitMsgHook,
	type CommitHookOptions,
	ensureCommitHook,
	installCommitHook,
	repoRootOf,
} from "../../../lib/core/attribution/commit-hook.ts";

// Wrap execFileSync so a test can count the git processes a call starts:
// each one is a synchronous spawn on pi's startup and command path.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const spawned = vi.mocked(execFileSync);

/** How many git processes fn started. */
function gitCallsDuring(fn: () => void): number {
	spawned.mockClear();
	fn();
	return spawned.mock.calls.filter(([command]) => command === "git").length;
}

const TRAILER = "Co-Authored-By: AI (Claude Opus 4.6 via Pi) <noreply@pi.dev>";

/** A stand-in adapter: env-var gated, matching pi's own real options. */
const OPTIONS: CommitHookOptions = {
	marker: "test-commit-attribution-hook",
	chainedSuffix: "test-chained",
	gateTest: '[ -n "$TEST_CO_AUTHOR" ]',
	trailerExpr: '"$TEST_CO_AUTHOR"',
};

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "attribution-hook-"));
}

function writeHook(dir: string): string {
	const path = join(dir, "prepare-commit-msg");
	writeFileSync(path, buildPrepareCommitMsgHook(OPTIONS), { mode: 0o755 });
	return path;
}

function initRepo(): string {
	const repo = tempDir();
	execFileSync("git", ["-C", repo, "init", "-q"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Tester"]);
	// A throwaway test repo should never depend on (or be broken by) the
	// developer's real commit-signing setup.
	execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
	return repo;
}

describe("buildPrepareCommitMsgHook", () => {
	it("appends the trailer when the gate env var is set", () => {
		const dir = tempDir();
		const hook = writeHook(dir);
		const msg = join(dir, "MSG");
		writeFileSync(msg, "feat: x\n");

		execFileSync("sh", [hook, msg], {
			env: { ...process.env, TEST_CO_AUTHOR: TRAILER },
		});

		expect(readFileSync(msg, "utf8")).toContain(TRAILER);
	});

	it("leaves the message untouched without the gate env var", () => {
		const dir = tempDir();
		const hook = writeHook(dir);
		const msg = join(dir, "MSG");
		writeFileSync(msg, "feat: x\n");

		const env = { ...process.env };
		delete env.TEST_CO_AUTHOR;
		execFileSync("sh", [hook, msg], { env });

		expect(readFileSync(msg, "utf8")).toBe("feat: x\n");
	});

	it("does not add a second trailer on a re-run", () => {
		const dir = tempDir();
		const hook = writeHook(dir);
		const msg = join(dir, "MSG");
		writeFileSync(msg, "feat: x\n");
		const env = { ...process.env, TEST_CO_AUTHOR: TRAILER };

		execFileSync("sh", [hook, msg], { env });
		execFileSync("sh", [hook, msg], { env });

		const occurrences =
			readFileSync(msg, "utf8").split("Co-Authored-By").length - 1;
		expect(occurrences).toBe(1);
	});
});

describe("ensureCommitHook", () => {
	it("installs into the repo of a subdirectory and records the root", () => {
		const repo = initRepo();
		const sub = join(repo, "a", "b");
		mkdirSync(sub, { recursive: true });
		const installed = new Set<string>();

		ensureCommitHook(sub, installed, OPTIONS);

		const hooksDir = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--git-path", "hooks"],
			{ encoding: "utf8" },
		).trim();
		expect(existsSync(join(repo, hooksDir, "prepare-commit-msg"))).toBe(true);
		expect(installed.has(repoRootOf(sub) ?? "")).toBe(true);
	});

	it("asks git once to install into a repo it has not seen", () => {
		const repo = initRepo();
		const sub = join(repo, "a");
		mkdirSync(sub);

		const calls = gitCallsDuring(() =>
			ensureCommitHook(sub, new Set(), OPTIONS),
		);

		expect(calls).toBe(1);
		expect(existsSync(join(repo, ".git/hooks/prepare-commit-msg"))).toBe(true);
	});

	it("asks git nothing for a directory it has already handled", () => {
		const repo = initRepo();
		const sub = join(repo, "a");
		mkdirSync(sub);
		const installed = new Set<string>();
		ensureCommitHook(sub, installed, OPTIONS);

		const again = gitCallsDuring(() => {
			ensureCommitHook(sub, installed, OPTIONS);
			ensureCommitHook(repoRootOf(sub) ?? "", installed, OPTIONS);
		});

		// repoRootOf itself is one call; ensureCommitHook adds none.
		expect(again).toBe(1);
	});

	it("installs into the shared hooks of a linked worktree", () => {
		const repo = initRepo();
		execFileSync("git", [
			"-C",
			repo,
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"x",
		]);
		const linked = join(tempDir(), "linked");
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", linked]);

		ensureCommitHook(linked, new Set(), OPTIONS);

		expect(existsSync(join(repo, ".git/hooks/prepare-commit-msg"))).toBe(true);
	});

	it("leaves a repo with a custom core.hooksPath alone", () => {
		const repo = initRepo();
		execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky"]);

		ensureCommitHook(repo, new Set(), OPTIONS);

		expect(existsSync(join(repo, ".husky/prepare-commit-msg"))).toBe(false);
		expect(existsSync(join(repo, ".git/hooks/prepare-commit-msg"))).toBe(false);
	});

	it("is a no-op for a directory outside any git repo", () => {
		const loose = tempDir();
		const installed = new Set<string>();

		expect(() => ensureCommitHook(loose, installed, OPTIONS)).not.toThrow();
		expect(installed.size).toBe(0);
	});
});

describe("installCommitHook", () => {
	it("installs and attributes a real commit end to end", () => {
		const repo = initRepo();

		expect(installCommitHook(repo, OPTIONS).installed).toBe(true);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", ["-C", repo, "commit", "-m", "feat: thing"], {
			env: { ...process.env, TEST_CO_AUTHOR: TRAILER },
		});

		const log = execFileSync("git", ["-C", repo, "log", "-1", "--pretty=%B"], {
			encoding: "utf8",
		});
		expect(log).toContain(TRAILER);
	});

	it("does not attribute a commit made without the gate env var", () => {
		const repo = initRepo();
		installCommitHook(repo, OPTIONS);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		const env = { ...process.env };
		delete env.TEST_CO_AUTHOR;
		execFileSync("git", ["-C", repo, "commit", "-m", "feat: human"], { env });

		const log = execFileSync("git", ["-C", repo, "log", "-1", "--pretty=%B"], {
			encoding: "utf8",
		});
		expect(log).not.toContain("Co-Authored-By");
	});

	it("refuses to install when a custom core.hooksPath is configured", () => {
		const repo = initRepo();
		execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky"]);

		const result = installCommitHook(repo, OPTIONS);

		expect(result.installed).toBe(false);
		expect(result.reason).toMatch(/hookspath/i);
	});

	it("refuses to clobber an existing chained backup", () => {
		const repo = initRepo();
		const hooksDir = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--git-path", "hooks"],
			{ encoding: "utf8" },
		).trim();
		const chained = join(
			repo,
			hooksDir,
			`prepare-commit-msg.${OPTIONS.chainedSuffix}`,
		);
		writeFileSync(chained, "#!/bin/sh\n# original backup\n", { mode: 0o755 });
		writeFileSync(join(repo, hooksDir, "prepare-commit-msg"), "#!/bin/sh\n", {
			mode: 0o755,
		});

		const result = installCommitHook(repo, OPTIONS);

		expect(result.installed).toBe(false);
		expect(readFileSync(chained, "utf8")).toContain("original backup");
	});

	it("is idempotent on a second install", () => {
		const repo = initRepo();

		expect(installCommitHook(repo, OPTIONS).installed).toBe(true);
		expect(installCommitHook(repo, OPTIONS)).toEqual({
			installed: false,
			reason: "already installed",
		});
	});

	it("aborts the commit when a chained hook exits non-zero", () => {
		const repo = initRepo();
		const hooksDir = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--git-path", "hooks"],
			{ encoding: "utf8" },
		).trim();
		const existing = join(repo, hooksDir, "prepare-commit-msg");
		writeFileSync(existing, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

		installCommitHook(repo, OPTIONS);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		expect(() =>
			execFileSync("git", ["-C", repo, "commit", "-m", "feat: thing"], {
				env: { ...process.env, TEST_CO_AUTHOR: TRAILER },
				stdio: "ignore",
			}),
		).toThrow();
	});

	it("chains a pre-existing hook", () => {
		const repo = initRepo();
		const hooksDir = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--git-path", "hooks"],
			{ encoding: "utf8" },
		).trim();
		const existing = join(repo, hooksDir, "prepare-commit-msg");
		writeFileSync(existing, '#!/bin/sh\nprintf "CHAINED\\n" >> "$1"\n', {
			mode: 0o755,
		});

		installCommitHook(repo, OPTIONS);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", ["-C", repo, "commit", "-m", "feat: thing"], {
			env: { ...process.env, TEST_CO_AUTHOR: TRAILER },
		});

		const log = execFileSync("git", ["-C", repo, "log", "-1", "--pretty=%B"], {
			encoding: "utf8",
		});
		expect(log).toContain("CHAINED");
		expect(log).toContain(TRAILER);
	});
});
