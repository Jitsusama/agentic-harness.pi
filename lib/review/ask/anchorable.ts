/**
 * Where a finding may legitimately point.
 *
 * A reviewer told only "anchor to the diff" will name a line it read
 * in the file and never noticed was outside a hunk, and the anchor
 * then degrades to a body comment carrying a line number that means
 * nothing. Telling it the ranges up front costs a few lines of
 * prompt and removes the whole class of mistake.
 *
 * Context lines count. A reviewer may legitimately point at an
 * unchanged line inside a hunk to say what the change around it
 * breaks, and every backend accepts an anchor there.
 */

import type { DiffFile, DiffModel } from "../diff.js";
import { filePath } from "../diff.js";

/** A run of lines, inclusive at both ends. */
export interface LineRange {
	from: number;
	to: number;
}

/** Where one file will accept an anchor, per side. */
export interface FileRanges {
	path: string;
	new: LineRange[];
	old: LineRange[];
}

/** Every file in a diff, with the ranges each side will accept. */
export function anchorableRanges(diff: DiffModel): FileRanges[] {
	return diff.files.map((file) => ({
		path: filePath(file),
		new: sideRanges(file, "new"),
		old: sideRanges(file, "old"),
	}));
}

/**
 * One line per file, both sides named.
 *
 * A side with nothing is left out rather than printed as empty: a
 * pure addition has no left side at all, and "old none" only invites
 * a reviewer to wonder what it meant.
 */
export function describeRanges(ranges: FileRanges[]): string {
	if (ranges.length === 0) {
		return "No line in this change can hold an anchor, so every finding has to be file-scoped or about the change as a whole.";
	}
	return ranges
		.map((file) => {
			const sides: string[] = [];
			if (file.new.length > 0) sides.push(`new ${list(file.new)}`);
			if (file.old.length > 0) sides.push(`old ${list(file.old)}`);
			return `${file.path}: ${sides.join(" | ")}`;
		})
		.join("\n");
}

/**
 * The ranges one side of one file will accept.
 *
 * Taken from the line numbers the hunks actually carry rather than
 * from the hunk headers, since a header counts lines on its side
 * while a range has to be bounded by lines that exist on it. One
 * range per hunk: the gap between two hunks is not in the diff, so a
 * range spanning it would invite an anchor nothing can hold.
 */
function sideRanges(file: DiffFile, side: "new" | "old"): LineRange[] {
	const ranges: LineRange[] = [];
	for (const hunk of file.hunks) {
		let from: number | undefined;
		let to: number | undefined;
		for (const line of hunk.lines) {
			const at = side === "new" ? line.newLine : line.oldLine;
			if (at === undefined) continue;
			if (from === undefined || at < from) from = at;
			if (to === undefined || at > to) to = at;
		}
		if (from !== undefined && to !== undefined) ranges.push({ from, to });
	}
	return ranges;
}

/** Several ranges on one side, as a reader would say them. */
function list(ranges: LineRange[]): string {
	return ranges.map((r) => `${r.from}-${r.to}`).join(", ");
}
