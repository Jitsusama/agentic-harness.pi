/**
 * Formats review threads for both UI display (panels and
 * workspace) and LLM context (briefings and analysis).
 */

import type { ReviewThread } from "../state.js";
import { threadPriority } from "../state.js";

/**
 * Format a summary of threads grouped by file for the
 * overview panel.
 */
export function formatFileSummary(threads: ReviewThread[]): string[] {
	const lines: string[] = [];
	const byFile = new Map<string, ReviewThread[]>();

	for (const thread of threads) {
		const existing = byFile.get(thread.file);
		if (existing) {
			existing.push(thread);
		} else {
			byFile.set(thread.file, [thread]);
		}
	}

	const sortedFiles = Array.from(byFile.entries()).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	for (const [file, fileThreads] of sortedFiles) {
		const required = fileThreads.filter(
			(t) => threadPriority(t) === "required",
		).length;
		const optional = fileThreads.filter(
			(t) => threadPriority(t) === "optional",
		).length;

		const total = fileThreads.length;
		const plural = total !== 1 ? "s" : "";
		let detail: string;

		if (required > 0 && optional > 0) {
			detail = `${required} req, ${optional} opt`;
		} else if (required > 0) {
			detail = `${required} req`;
		} else {
			detail = `${optional} opt`;
		}

		lines.push(`  • ${file} (${total} thread${plural}: ${detail})`);
	}

	return lines;
}
