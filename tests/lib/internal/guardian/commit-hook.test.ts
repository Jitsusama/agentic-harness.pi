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
import { describe, expect, it } from "vitest";
import {
	ensureCommitHook,
	installCommitHook,
	PREPARE_COMMIT_MSG_HOOK,
	repoRootOf,
} from "../../../../lib/internal/guardian/commit-hook.js";

const TRAILER = "Co-Authored-By: AI (Claude Opus 4.6 via Pi) <noreply@pi.dev>";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-hook-"));
}

function writeHook(dir: string): string {
	const path = join(dir, "prepare-commit-msg");
	writeFileSync(path, PREPARE_COMMIT_MSG_HOOK, { mode: 0o755 });
	return path;
}

function initRepo(): string {
	const repo = tempDir();
	execFileSync("git", ["-C", repo, "init", "-q"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Tester"]);
	return repo;
}

describe("PREPARE_COMMIT_MSG_HOOK", () => {
	it("appends the trailer when PI_CO_AUTHOR is set", () => {
		const dir = tempDir();
		const hook = writeHook(dir);
		const msg = join(dir, "MSG");
		writeFileSync(msg, "feat: x\n");

		execFileSync("sh", [hook, msg], {
			env: { ...process.env, PI_CO_AUTHOR: TRAILER },
		});

		expect(readFileSync(msg, "utf8")).toContain(TRAILER);
	});

	it("leaves the message untouched without PI_CO_AUTHOR", () => {
		const dir = tempDir();
		const hook = writeHook(dir);
		const msg = join(dir, "MSG");
		writeFileSync(msg, "feat: x\n");

		const env = { ...process.env };
		delete env.PI_CO_AUTHOR;
		execFileSync("sh", [hook, msg], { env });

		expect(readFileSync(msg, "utf8")).toBe("feat: x\n");
	});

	it("does not add a second trailer on a re-run", () => {
		const dir = tempDir();
		const hook = writeHook(dir);
		const msg = join(dir, "MSG");
		writeFileSync(msg, "feat: x\n");
		const env = { ...process.env, PI_CO_AUTHOR: TRAILER };

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

		ensureCommitHook(sub, installed);

		const hooksDir = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--git-path", "hooks"],
			{ encoding: "utf8" },
		).trim();
		expect(existsSync(join(repo, hooksDir, "prepare-commit-msg"))).toBe(true);
		expect(installed.has(repoRootOf(sub) ?? "")).toBe(true);
	});

	it("is a no-op for a directory outside any git repo", () => {
		const loose = tempDir();
		const installed = new Set<string>();

		expect(() => ensureCommitHook(loose, installed)).not.toThrow();
		expect(installed.size).toBe(0);
	});
});

describe("installCommitHook", () => {
	it("installs and attributes a real commit end to end", () => {
		const repo = initRepo();

		expect(installCommitHook(repo).installed).toBe(true);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", ["-C", repo, "commit", "-m", "feat: thing"], {
			env: { ...process.env, PI_CO_AUTHOR: TRAILER },
		});

		const log = execFileSync("git", ["-C", repo, "log", "-1", "--pretty=%B"], {
			encoding: "utf8",
		});
		expect(log).toContain(TRAILER);
	});

	it("does not attribute a commit made without PI_CO_AUTHOR", () => {
		const repo = initRepo();
		installCommitHook(repo);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		const env = { ...process.env };
		delete env.PI_CO_AUTHOR;
		execFileSync("git", ["-C", repo, "commit", "-m", "feat: human"], { env });

		const log = execFileSync("git", ["-C", repo, "log", "-1", "--pretty=%B"], {
			encoding: "utf8",
		});
		expect(log).not.toContain("Co-Authored-By");
	});

	it("refuses to install when a custom core.hooksPath is configured", () => {
		const repo = initRepo();
		execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky"]);

		const result = installCommitHook(repo);

		expect(result.installed).toBe(false);
		expect(result.reason).toMatch(/hookspath/i);
	});

	it("refuses to clobber an existing .pi-chained backup", () => {
		const repo = initRepo();
		const hooksDir = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--git-path", "hooks"],
			{ encoding: "utf8" },
		).trim();
		const chained = join(repo, hooksDir, "prepare-commit-msg.pi-chained");
		writeFileSync(chained, "#!/bin/sh\n# original backup\n", { mode: 0o755 });
		writeFileSync(join(repo, hooksDir, "prepare-commit-msg"), "#!/bin/sh\n", {
			mode: 0o755,
		});

		const result = installCommitHook(repo);

		expect(result.installed).toBe(false);
		expect(readFileSync(chained, "utf8")).toContain("original backup");
	});

	it("is idempotent on a second install", () => {
		const repo = initRepo();

		expect(installCommitHook(repo).installed).toBe(true);
		expect(installCommitHook(repo)).toEqual({
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

		installCommitHook(repo);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		expect(() =>
			execFileSync("git", ["-C", repo, "commit", "-m", "feat: thing"], {
				env: { ...process.env, PI_CO_AUTHOR: TRAILER },
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

		installCommitHook(repo);

		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", ["-C", repo, "commit", "-m", "feat: thing"], {
			env: { ...process.env, PI_CO_AUTHOR: TRAILER },
		});

		const log = execFileSync("git", ["-C", repo, "log", "-1", "--pretty=%B"], {
			encoding: "utf8",
		});
		expect(log).toContain("CHAINED");
		expect(log).toContain(TRAILER);
	});
});
