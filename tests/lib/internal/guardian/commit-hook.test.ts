/**
 * The commit-hook mechanism itself (idempotent install, chaining,
 * the trailer append) is agentic-harness.core's own test coverage.
 * This checks only what's pi's: that PI_CO_AUTHOR is really the
 * gate a real installed hook reacts to.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCommitHook } from "../../../../lib/internal/guardian/commit-hook.js";

const TRAILER = "Co-Authored-By: AI (Claude Opus 4.6 via Pi) <noreply@pi.dev>";

function initRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-hook-"));
	execFileSync("git", ["-C", repo, "init", "-q"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Tester"]);
	// A throwaway test repo should never depend on (or be broken by) the
	// developer's real commit-signing setup.
	execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
	return repo;
}

describe("pi's installed commit hook", () => {
	it("attributes a commit made with PI_CO_AUTHOR set", () => {
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

	it("leaves a commit made without PI_CO_AUTHOR unattributed", () => {
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
});
