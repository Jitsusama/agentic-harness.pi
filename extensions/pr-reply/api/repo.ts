/**
 * Repository discovery and directory switching.
 *
 * When the PR belongs to a different repo than the current
 * directory, we detect the user's terminal and open a new tab
 * with pi already running in the correct directory, pre-loaded
 * with the PR reply context.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "./github.js";
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

/**
 * Get the current repository's owner and repo from git remote.
 */
export async function getCurrentRepo(
	pi: ExtensionAPI,
): Promise<{ owner: string; repo: string } | null> {
	const result = await pi.exec("git", ["config", "--get", "remote.origin.url"]);

	if (result.code !== 0) return null;
	return extractOwnerRepo(result.stdout.trim());
}

/** Get the current branch name. */
export async function getCurrentBranch(
	pi: ExtensionAPI,
): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

	if (result.code !== 0) return null;
	return result.stdout.trim();
}

/** Find the PR number associated with the current branch. */
export async function findPRForBranch(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	branch: string,
): Promise<number | null> {
	const result = await pi.exec("gh", [
		"pr",
		"list",
		"--repo",
		`${owner}/${repo}`,
		"--head",
		branch,
		"--json",
		"number",
		"--jq",
		".[0].number",
	]);

	if (result.code !== 0 || !result.stdout.trim()) return null;

	const prNumber = Number.parseInt(result.stdout.trim(), 10);
	return Number.isNaN(prNumber) ? null : prNumber;
}

/** Find dependent PRs (PRs whose base is the given branch). */
export async function findDependentPRs(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	branch: string,
): Promise<number[]> {
	const result = await pi.exec("gh", [
		"pr",
		"list",
		"--repo",
		`${owner}/${repo}`,
		"--base",
		branch,
		"--json",
		"number",
		"--jq",
		".[].number",
	]);

	if (result.code !== 0 || !result.stdout.trim()) return [];

	return result.stdout
		.trim()
		.split("\n")
		.map((n) => Number.parseInt(n, 10))
		.filter((n) => !Number.isNaN(n));
}

/** Result of attempting to switch to a repo. */
export type SwitchResult =
	| { status: "already-here" }
	| { status: "opened-tab"; repoPath: string }
	| { status: "not-found-opened-tab-failed"; repoPath: string }
	| { status: "not-found" };

/**
 * Ensure we're in the correct repository for the PR.
 *
 * Returns a structured result so the caller can give the LLM
 * a clear message about what happened.
 */
export async function switchToRepo(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<SwitchResult> {
	const current = await getCurrentRepo(pi);
	if (current?.owner === ref.owner && current?.repo === ref.repo) {
		return { status: "already-here" };
	}

	const repoPath = findRepoOnDisk(ref);
	if (!repoPath) {
		return { status: "not-found" };
	}

	const opened = await openInNewTab(pi, repoPath, ref);
	if (opened) {
		return { status: "opened-tab", repoPath };
	}

	return { status: "not-found-opened-tab-failed", repoPath };
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
 * Open a new terminal tab with pi running in the given directory,
 * pre-loaded with the PR reply prompt.
 */
async function openInNewTab(
	pi: ExtensionAPI,
	repoPath: string,
	ref: PRReference,
): Promise<boolean> {
	const terminal = detectTerminal();
	const prompt = `respond to reviews on ${ref.owner}/${ref.repo}#${ref.number}`;

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

/**
 * Open a new window in Ghostty.
 *
 * Ghostty doesn't have a CLI for opening tabs in an existing
 * instance. We launch a new Ghostty window with the command.
 */
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

// ---- Repo discovery ----

/**
 * Search common locations on disk for the repository.
 * Returns the directory path if found, null otherwise.
 */
export function findRepoOnDisk(ref: PRReference): string | null {
	const home = os.homedir();

	for (const pattern of REPO_SEARCH_PATHS) {
		const candidate = path.join(
			home,
			pattern.replace("{owner}", ref.owner).replace("{repo}", ref.repo),
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
