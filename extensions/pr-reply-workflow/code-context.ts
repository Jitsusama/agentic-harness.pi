/**
 * Source code context reading: extracts a snippet around a
 * commented line so thread displays can show relevant code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
