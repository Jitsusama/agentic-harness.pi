/**
 * Source code context reading: extracts a snippet around a
 * commented line so thread displays can show relevant code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { languageFromPath } from "../../lib/ui/index.js";

/** Code context around a commented line, ready for rendering. */
export interface CodeContext {
	source: string;
	startLine: number;
	highlightLine: number;
	language: string;
}

/** Lines of surrounding context to read above and below. */
const CONTEXT_RADIUS = 5;

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

	return {
		source: result.stdout,
		startLine,
		highlightLine: line,
		language: languageFromPath(filePath) ?? "",
	};
}
