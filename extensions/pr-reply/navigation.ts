/**
 * Figures out which PR we're working on and reads the
 * surrounding source code so thread displays can show
 * relevant context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "./api/github.js";
import { parsePRReference } from "./api/parse.js";
import {
	findPRForBranch,
	getCurrentBranch,
	getCurrentRepo,
} from "./api/repo.js";

/** Code context around a commented line, ready for rendering. */
export interface CodeContext {
	source: string;
	startLine: number;
	highlightLine: number;
	language: string;
}

/** Lines of surrounding context to read above and below. */
const CONTEXT_RADIUS = 5;

/** Map file extensions to language names for syntax highlighting. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	md: "markdown",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	sh: "bash",
	css: "css",
	html: "html",
};

/**
 * Resolve a PR reference from user input or the current branch.
 * Tries explicit input first, then falls back to detecting the
 * PR associated with the current branch.
 */
export async function resolvePR(
	pi: ExtensionAPI,
	prInput: string | null,
): Promise<PRReference | null> {
	if (prInput) {
		const currentRepo = await getCurrentRepo(pi);
		const ref = parsePRReference(
			prInput,
			currentRepo?.owner,
			currentRepo?.repo,
		);
		if (ref) return ref;
	}

	const currentRepo = await getCurrentRepo(pi);
	const currentBranch = await getCurrentBranch(pi);

	if (currentRepo && currentBranch) {
		const prNumber = await findPRForBranch(
			pi,
			currentRepo.owner,
			currentRepo.repo,
			currentBranch,
		);

		if (prNumber) {
			return {
				owner: currentRepo.owner,
				repo: currentRepo.repo,
				number: prNumber,
			};
		}
	}

	return null;
}

/**
 * Get the head branch name for a PR from GitHub.
 */
export async function getPRBranch(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<string | null> {
	const result = await pi.exec("gh", [
		"pr",
		"view",
		String(ref.number),
		"--repo",
		`${ref.owner}/${ref.repo}`,
		"--json",
		"headRefName",
		"--jq",
		".headRefName",
	]);
	if (result.code !== 0 || !result.stdout.trim()) return null;
	return result.stdout.trim();
}

/**
 * Read source code around a commented line for context display.
 * Returns the source fragment with line metadata for renderCode.
 */
export async function readCodeContext(
	pi: ExtensionAPI,
	filePath: string,
	line: number,
): Promise<CodeContext | null> {
	const startLine = Math.max(1, line - CONTEXT_RADIUS);
	const endLine = line + CONTEXT_RADIUS;

	const result = await pi.exec("sed", [
		"-n",
		`${startLine},${endLine}p`,
		filePath,
	]);

	if (result.code !== 0 || !result.stdout) return null;

	const ext = filePath.split(".").pop() ?? "";

	return {
		source: result.stdout,
		startLine,
		highlightLine: line,
		language: LANGUAGE_BY_EXTENSION[ext] ?? "",
	};
}

/**
 * Push to the remote if there are unpushed commits.
 * Non-fatal: replies still post if push fails, but SHAs
 * won't be clickable on GitHub until the next push.
 */
export async function pushIfNeeded(pi: ExtensionAPI): Promise<void> {
	const status = await pi.exec("git", [
		"rev-list",
		"--count",
		"@{upstream}..HEAD",
	]);

	const ahead = Number.parseInt(status.stdout.trim(), 10);
	if (Number.isNaN(ahead) || ahead === 0) return;

	await pi.exec("git", ["push"]);
	// Non-fatal: the reply will still be posted
}
