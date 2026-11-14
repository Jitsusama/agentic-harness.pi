import { execFile, execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
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

// Wrap both spawns so a test can count the git processes a call starts:
// each one is a spawn on pi's startup and command path.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(actual.execFile),
		execFileSync: vi.fn(actual.execFileSync),
	};
});

const spawnedSync = vi.mocked(execFileSync);
const spawned = vi.mocked(execFile);

/** How many git processes fn started, waited for or not. */
async function gitCallsDuring(fn: () => unknown): Promise<number> {
	spawnedSync.mockClear();
	spawned.mockClear();
	await fn();
	return [...spawnedSync.mock.calls, ...spawned.mock.calls].filter(
		([command]) => command === "git",
	).length;
}

const TRAILER = "Co-Authored-By: AI (Claude Opus 4.6 via Pi) <noreply@pi.dev>";

/** A stand-in adapter: env-var gated, matching pi's own real options. */
const OPTIONS: CommitHookOptions = {
	marker: "test-commit-attribution-hook",
	chainedSuffix: "test-chained",
	gateTest: '[ -n "$TEST_CO_AUTHOR" ]',
	trailerExpr: '"$TEST_CO_AUTHOR"',
};

/**
 * A folder named as git names it, with no symlink on the way: a
 * symlinked /tmp hid that a command run at a repo's own root never got
 * the hook, since only a root named some other way was installed into.
 */
function tempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "attribution-hook-")));
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
	it("writes each option in, leaving no blank for git to run", () => {
		const hook = buildPrepareCommitMsgHook(OPTIONS);

		expect(hook).toContain(`# ${OPTIONS.marker}\n`);
		expect(hook).toContain(`${OPTIONS.gateTest} || exit 0`);
		expect(hook).toContain(`--trailer ${OPTIONS.trailerExpr} `);
		expect(hook).not.toMatch(/@\w+@/);
	});

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
	it("installs into the repo of a subdirectory and records the root", async () => {
		const repo = initRepo();
		const sub = join(repo, "a", "b");
		mkdirSync(sub, { recursive: true });
		const installed = new Set<string>();

		await ensureCommitHook(sub, installed, OPTIONS);

		const hooksDir = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--git-path", "hooks"],
			{ encoding: "utf8" },
		).trim();
		const hook = join(repo, hooksDir, "prepare-commit-msg");
		expect(existsSync(hook), `${hook} exists`).toBe(true);
		expect([...installed]).toContain(repoRootOf(sub) ?? "");
	});

	it("asks git once to install into a repo it has not seen", async () => {
		const repo = initRepo();
		const sub = join(repo, "a");
		mkdirSync(sub);

		const calls = await gitCallsDuring(() =>
			ensureCommitHook(sub, new Set(), OPTIONS),
		);

		expect(calls, "git processes started").toBe(1);
		const hook = join(repo, ".git/hooks/prepare-commit-msg");
		expect(existsSync(hook), `${hook} exists`).toBe(true);
	});

	it("asks git nothing for a directory it has already handled", async () => {
		const repo = initRepo();
		const sub = join(repo, "a");
		mkdirSync(sub);
		const installed = new Set<string>();
		await ensureCommitHook(sub, installed, OPTIONS);

		const again = await gitCallsDuring(async () => {
			await ensureCommitHook(sub, installed, OPTIONS);
			await ensureCommitHook(repoRootOf(sub) ?? "", installed, OPTIONS);
		});

		// repoRootOf itself is one call; ensureCommitHook adds none.
		expect(again, "git processes started").toBe(1);
	});

	it("installs into the shared hooks of a linked worktree", async () => {
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

		await ensureCommitHook(linked, new Set(), OPTIONS);

		const hook = join(repo, ".git/hooks/prepare-commit-msg");
		expect(existsSync(hook), `${hook} exists`).toBe(true);
	});

	it("leaves a repo with a custom core.hooksPath alone", async () => {
		const repo = initRepo();
		execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky"]);

		await ensureCommitHook(repo, new Set(), OPTIONS);

		const husky = join(repo, ".husky/prepare-commit-msg");
		const git = join(repo, ".git/hooks/prepare-commit-msg");
		expect(existsSync(husky), `${husky} is not written`).toBe(false);
		expect(existsSync(git), `${git} is not written`).toBe(false);
	});

	it("is a no-op for a directory outside any git repo", async () => {
		const loose = tempDir();
		const installed = new Set<string>();

		await ensureCommitHook(loose, installed, OPTIONS);
		expect(installed.size, "folders remembered").toBe(0);
	});

	// Every bash call asks, and a folder in no repo was never remembered,
	// so each call there started a git forked from pi's loop: in a host,
	// the loop every conversation waits on, 442 ms of one turn in a soak
	// of twelve (13 November).
	it("asks git nothing for a directory outside any git repo, however often", async () => {
		const loose = tempDir();
		const installed = new Set<string>();

		const calls = await gitCallsDuring(async () => {
			await ensureCommitHook(loose, installed, OPTIONS);
			await ensureCommitHook(loose, installed, OPTIONS);
		});

		expect(calls, "git processes started").toBe(0);
	});

	it("asks git nothing for a new folder of a repo it has handled", async () => {
		const repo = initRepo();
		const first = join(repo, "a");
		const second = join(repo, "b");
		mkdirSync(first);
		mkdirSync(second);
		const installed = new Set<string>();
		await ensureCommitHook(first, installed, OPTIONS);

		const calls = await gitCallsDuring(() =>
			ensureCommitHook(second, installed, OPTIONS),
		);

		expect(calls, "git processes started").toBe(0);
	});

	it("covers a repo made in a folder it found none in", async () => {
		const repo = tempDir();
		const installed = new Set<string>();
		await ensureCommitHook(repo, installed, OPTIONS);
		execFileSync("git", ["-C", repo, "init", "-q"]);

		await ensureCommitHook(repo, installed, OPTIONS);

		const hook = join(repo, ".git/hooks/prepare-commit-msg");
		expect(existsSync(hook), `${hook} exists`).toBe(true);
	});
});

describe("installCommitHook", () => {
	it("installs and attributes a real commit end to end", () => {
		const repo = initRepo();

		expect(installCommitHook(repo, OPTIONS)).toMatchObject({ installed: true });

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

		expect(result).toMatchObject({ installed: false });
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

		expect(result).toMatchObject({ installed: false });
		expect(readFileSync(chained, "utf8")).toContain("original backup");
	});

	it("is idempotent on a second install", () => {
		const repo = initRepo();

		expect(installCommitHook(repo, OPTIONS)).toMatchObject({ installed: true });
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
