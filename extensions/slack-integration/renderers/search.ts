/**
 * Format search results as readable text.
 */

import type { SlackFileResult } from "../api/search.js";

/** Render file search results. */
export function renderFileList(
	files: SlackFileResult[],
	total: number,
): string {
	if (files.length === 0) {
		return "No files found.";
	}

	const lines: string[] = [];
	lines.push(`Found ${total} file(s), showing ${files.length}:\n`);

	for (const f of files) {
		const size = f.size ? ` (${formatBytes(f.size)})` : "";
		const type = f.mimetype ? ` [${f.mimetype}]` : "";
		lines.push(`- **${f.name}**${type}${size}`);
		if (f.title && f.title !== f.name) {
			lines.push(`  Title: ${f.title}`);
		}
		if (f.permalink) {
			lines.push(`  ${f.permalink}`);
		}
	}

	return lines.join("\n");
}

/** Format byte count as a human-readable string. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
