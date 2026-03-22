/**
 * Repository discovery and terminal tab spawning: find repos
 * on disk and open new terminal tabs for cross-repo workflows.
 *
 * Used by pr-review-workflow and pr-reply-workflow when the target PR belongs
 * to a different repo than the current working directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractOwnerRepo } from "./pr-reference.js";

/**
 * Common locations where repos live, relative to home.
 * Searched in order: first match wins.
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

/**
 * Get the current repository's owner and repo from git remote.
 * Returns null if not in a git repo or remote isn't GitHub.
 */
export async function getCurrentRepo(
	pi: ExtensionAPI,
): Promise<{ owner: string; repo: string } | null> {
	const result = await pi.exec("git", ["config", "--get", "remote.origin.url"]);
	if (result.code !== 0) return null;
	return extractOwnerRepo(result.stdout.trim());
}

/**
 * Get the repo root directory from git.
 * Returns null if not in a git repo.
 */
export async function getRepoRoot(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return null;
	return result.stdout.trim();
}

/**
 * Search common locations on disk for a GitHub repository.
 * Returns the directory path if found, null otherwise.
 */
export function findRepoOnDisk(owner: string, repo: string): string | null {
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

/**
 * Open a new terminal tab with pi running in the given
 * directory, pre-loaded with a prompt string.
 *
 * Detects the current terminal (WezTerm, Ghostty) and uses
 * its CLI to spawn a new tab. Returns false if the terminal
 * is unsupported.
 */
export async function openInNewTab(
	pi: ExtensionAPI,
	repoPath: string,
	prompt: string,
): Promise<boolean> {
	const terminal = detectTerminal();

	switch (terminal) {
		case "wezterm":
			return spawnWezterm(pi, repoPath, prompt);
		case "ghostty":
			return spawnGhostty(pi, repoPath, prompt);
		default:
			return false;
	}
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
 * Open a new window in Ghostty. Ghostty doesn't have a CLI
 * for opening tabs in an existing instance: we launch a new
 * Ghostty window with the command.
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
