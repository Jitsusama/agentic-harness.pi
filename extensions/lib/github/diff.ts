/**
 * Diff fetching and parsing: fetch unified diffs from GitHub
 * and parse them into structured per-file data.
 *
 * Used by pr-review-workflow for its workspace diff views and by
 * pr-annotate-workflow for comment context overlay.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "./pr-reference.js";

/** A parsed diff file with hunks. */
export interface DiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
}

/** A single hunk in a diff file. */
export interface DiffHunk {
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

/** A single line in a diff hunk. */
export interface DiffLine {
	type: "context" | "added" | "removed";
	content: string;
	oldLineNumber: number | null;
	newLineNumber: number | null;
}

/** A new-side line range covered by a single diff hunk. */
export interface HunkRange {
	readonly start: number;
	readonly end: number;
}

/**
 * Build a map of file path → hunk ranges (new-side line numbers).
 * GitHub's review API only accepts lines within these ranges.
 */
export function buildHunkRanges(files: DiffFile[]): Map<string, HunkRange[]> {
	const map = new Map<string, HunkRange[]>();

	for (const file of files) {
		const ranges: HunkRange[] = [];
		for (const hunk of file.hunks) {
			ranges.push({
				start: hunk.newStart,
				end: hunk.newStart + hunk.newCount - 1,
			});
		}
		map.set(file.path, ranges);
	}

	return map;
}

/**
 * Clamp a line number to a valid diff hunk range. Returns the
 * line unchanged if it falls within a hunk; otherwise returns
 * the nearest hunk boundary.
 */
export function clampToHunkRange(
	line: number,
	ranges: HunkRange[] | undefined,
): number {
	if (!ranges || ranges.length === 0) return line;

	for (const r of ranges) {
		if (line >= r.start && line <= r.end) return line;
	}

	let closest = line;
	let minDist = Number.MAX_SAFE_INTEGER;
	for (const r of ranges) {
		for (const boundary of [r.start, r.end]) {
			const dist = Math.abs(boundary - line);
			if (dist < minDist) {
				minDist = dist;
				closest = boundary;
			}
		}
	}
	return closest;
}

/** Fetch the unified diff for a PR via gh CLI. */
export async function fetchDiff(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<string> {
	const result = await pi.exec("gh", [
		"pr",
		"diff",
		String(ref.number),
		"--repo",
		`${ref.owner}/${ref.repo}`,
	]);

	if (result.code !== 0) {
		throw new Error(`Failed to fetch diff: ${result.stderr}`);
	}

	return result.stdout;
}

/** Parse unified diff output into per-file structures. */
export function parseDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	const fileSections = diff.split(/^diff --git /m).filter(Boolean);

	for (const section of fileSections) {
		const lines = section.split("\n");
		const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const newPath = headerMatch[2];
		let status: DiffFile["status"] = "modified";
		let additions = 0;
		let deletions = 0;

		if (lines.some((l) => l.startsWith("new file"))) {
			status = "added";
		} else if (lines.some((l) => l.startsWith("deleted file"))) {
			status = "deleted";
		} else if (lines.some((l) => l.startsWith("rename from"))) {
			status = "renamed";
		}

		const hunks: DiffHunk[] = [];
		let currentHunk: DiffHunk | null = null;
		let oldLine = 0;
		let newLine = 0;

		for (const line of lines) {
			const hunkMatch = line.match(
				/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
			);
			if (hunkMatch) {
				if (currentHunk) hunks.push(currentHunk);
				const oldStart = Number.parseInt(hunkMatch[1], 10);
				const oldCount = Number.parseInt(hunkMatch[2] ?? "1", 10);
				const newStart = Number.parseInt(hunkMatch[3], 10);
				const newCount = Number.parseInt(hunkMatch[4] ?? "1", 10);
				oldLine = oldStart;
				newLine = newStart;
				currentHunk = {
					header: line,
					oldStart,
					oldCount,
					newStart,
					newCount,
					lines: [],
				};
				continue;
			}

			if (!currentHunk) continue;

			if (line.startsWith("+")) {
				const diffLine: DiffLine = {
					type: "added",
					content: line.slice(1),
					oldLineNumber: null,
					newLineNumber: newLine,
				};
				currentHunk.lines.push(diffLine);
				newLine++;
				additions++;
			} else if (line.startsWith("-")) {
				const diffLine: DiffLine = {
					type: "removed",
					content: line.slice(1),
					oldLineNumber: oldLine,
					newLineNumber: null,
				};
				currentHunk.lines.push(diffLine);
				oldLine++;
				deletions++;
			} else if (line.startsWith(" ") || line === "") {
				const diffLine: DiffLine = {
					type: "context",
					content: line.startsWith(" ") ? line.slice(1) : line,
					oldLineNumber: oldLine,
					newLineNumber: newLine,
				};
				currentHunk.lines.push(diffLine);
				oldLine++;
				newLine++;
			}
		}

		if (currentHunk) hunks.push(currentHunk);

		files.push({ path: newPath, status, hunks, additions, deletions });
	}

	return files;
}
