/**
 * Repository discovery and directory switching for PR review.
 *
 * Finds the target repo on disk and handles switching when
 * the PR belongs to a different repo than the current cwd.
 * Reuses patterns from pr-reply/api/repo.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractOwnerRepo } from "./parse.js";

/**
 * Common locations where repos live, relative to home.
 * Searched in order — first match wins.
 */
const REPO_SEARCH_PATHS = [
	"src/github.com/{owner}/{repo}",
	"code/{repo}",
	"projects/{repo}",
	"dev/{repo}",
	"{repo}",
];

/** Terminal types we can open new tabs in. */
type Terminal = "wezterm" | "ghostty" | "unknown";

// ---- Public API ----

/** Result of resolving a repo for PR review. */
export type RepoResult =
	| { status: "current"; repoPath: string }
	| { status: "switched"; repoPath: string }
	| { status: "switch-failed"; repoPath: string }
	| { status: "not-found" };

/**
 * Resolve the repository for a PR review.
 *
 * Checks if the current directory is the target repo. If not,
 * searches common locations on disk. If found elsewhere, opens
 * a new terminal tab with pi pre-loaded.
 */
export async function resolveRepo(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<RepoResult> {
	const current = await getCurrentRepo(pi);
	if (current?.owner === owner && current?.repo === repo) {
		const repoPath = await getRepoRoot(pi);
		return { status: "current", repoPath: repoPath ?? process.cwd() };
	}

	const repoPath = findRepoOnDisk(owner, repo);
	if (!repoPath) {
		return { status: "not-found" };
	}

	const opened = await openInNewTab(pi, repoPath, owner, repo, prNumber);
	if (opened) {
		return { status: "switched", repoPath };
	}

	return { status: "switch-failed", repoPath };
}

// ---- Helpers ----

/** Get the current repository's owner and repo from git remote. */
async function getCurrentRepo(
	pi: ExtensionAPI,
): Promise<{ owner: string; repo: string } | null> {
	const result = await pi.exec("git", ["config", "--get", "remote.origin.url"]);
	if (result.code !== 0) return null;
	return extractOwnerRepo(result.stdout.trim());
}

/** Get the repo root directory. */
async function getRepoRoot(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return null;
	return result.stdout.trim();
}

/** Search common locations on disk for the repository. */
function findRepoOnDisk(owner: string, repo: string): string | null {
	const home = os.homedir();

	for (const pattern of REPO_SEARCH_PATHS) {
		const candidate = path.join(
			home,
			pattern.replace("{owner}", owner).replace("{repo}", repo),
		);

		if (isGitRepo(candidate)) {
			return candidate;
		}
	}

	return null;
}

/** Check if a directory is a git repository. */
function isGitRepo(dir: string): boolean {
	try {
		return fs.statSync(path.join(dir, ".git")).isDirectory();
	} catch {
		/* Directory doesn't exist or isn't accessible */
		return false;
	}
}

// ---- Terminal detection and tab spawning ----

/** Detect the current terminal from environment variables. */
function detectTerminal(): Terminal {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? "";

	if (termProgram === "wezterm" || process.env.WEZTERM_PANE) {
		return "wezterm";
	}

	if (termProgram === "ghostty" || process.env.GHOSTTY_RESOURCES_DIR) {
		return "ghostty";
	}

	return "unknown";
}

/**
 * Open a new terminal tab with pi pre-loaded for the review.
 */
async function openInNewTab(
	pi: ExtensionAPI,
	repoPath: string,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<boolean> {
	const terminal = detectTerminal();
	const prompt = `review ${owner}/${repo}#${prNumber}`;

	switch (terminal) {
		case "wezterm":
			return spawnWezterm(pi, repoPath, prompt);
		case "ghostty":
			return spawnGhostty(pi, repoPath, prompt);
		default:
			return false;
	}
}

/** Open a new tab in WezTerm. */
async function spawnWezterm(
	pi: ExtensionAPI,
	cwd: string,
	prompt: string,
): Promise<boolean> {
	const result = await pi.exec("wezterm", [
		"cli",
		"spawn",
		"--cwd",
		cwd,
		"--",
		"pi",
		prompt,
	]);
	return result.code === 0;
}

/** Open a new window in Ghostty. */
async function spawnGhostty(
	pi: ExtensionAPI,
	cwd: string,
	prompt: string,
): Promise<boolean> {
	const result = await pi.exec("ghostty", [
		`--working-directory=${cwd}`,
		"-e",
		"pi",
		prompt,
	]);
	return result.code === 0;
}
