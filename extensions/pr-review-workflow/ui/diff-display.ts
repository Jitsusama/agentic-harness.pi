/**
 * Diff file display: transforms structured DiffFile data into
 * display-ready forms for workspace tabs. Produces the unified
 * diff text content and the short tab label for a file.
 */

import type { DiffFile } from "../../../lib/internal/github/diff.js";

/** Build a unified diff string from a DiffFile's hunks. */
export function buildDiffText(file: DiffFile): string | null {
	if (file.hunks.length === 0) return null;

	const lines: string[] = [];
	for (const hunk of file.hunks) {
		lines.push(hunk.header);
		for (const line of hunk.lines) {
			const prefix =
				line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
			lines.push(`${prefix}${line.content}`);
		}
	}
	return lines.join("\n");
}

/** Extract the filename from a path for use as a short tab label. */
export function shortPath(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}
