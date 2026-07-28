/**
 * Where a remark attaches to a change.
 *
 * The shape is git's: a path, a side (the file before or the
 * file after), a line or line range, and the commit the
 * anchor was formed against. That last field is what makes
 * an anchor honest across a force-push. One backend keeps
 * the witness commit reachable and has no notion of a stale
 * comment; another strands the thread and reports it as
 * outdated. Recording the witness lets the substrate say
 * which of those happened instead of guessing.
 */

import type { DiffFile, DiffHunk, DiffModel, DiffSide } from "./diff.js";

export type { DiffSide };

/** A remark about one line or a run of lines. */
export interface LineAnchor {
	subject: "line";
	path: string;
	blob: DiffSide;
	/** Last line of the range, or the only line. */
	line: number;
	/** First line of a multi-line range. */
	startLine?: number;
	/** Commit the anchor was formed against. */
	witness?: string;
}

/** A remark about a file as a whole. */
export interface FileAnchor {
	subject: "file";
	path: string;
	/** Side the path is named on. Defaults to the new side. */
	blob?: DiffSide;
	witness?: string;
}

/** Where a remark attaches. */
export type Anchor = LineAnchor | FileAnchor;

/** Why an anchor cannot land on a diff. */
export type AnchorRefusal =
	| "file-absent"
	| "line-absent"
	| "range-inverted"
	| "range-crosses-hunks";

/** Whether an anchor lands, and what it landed on. */
export type AnchorCheck =
	| { anchored: true; file: DiffFile; hunk?: DiffHunk }
	| { anchored: false; reason: AnchorRefusal };

/** The side an anchor names, defaulting to the new side. */
function sideOf(anchor: Anchor): DiffSide {
	return anchor.blob ?? "new";
}

/** The path a file carries on one side of the diff. */
function pathOn(file: DiffFile, side: DiffSide): string | undefined {
	return side === "old" ? file.oldPath : file.newPath;
}

/** Whether a hunk line exists on the given side. */
function lineOn(hunk: DiffHunk, side: DiffSide, line: number): boolean {
	return hunk.lines.some((entry) =>
		side === "old" ? entry.oldLine === line : entry.newLine === line,
	);
}

/** The hunk holding a line on the given side, if any. */
function hunkHolding(
	file: DiffFile,
	side: DiffSide,
	line: number,
): DiffHunk | undefined {
	return file.hunks.find((hunk) => lineOn(hunk, side, line));
}

/**
 * Decide whether an anchor can land on a diff.
 *
 * A line anchor lands when the diff shows that line on the
 * side the anchor names: an added line exists only on the
 * new side, a removed line only on the old side, and a
 * context line on both. A range must sit inside one hunk,
 * because a remark spanning a gap in the diff has no
 * meaning to a reader and no backend accepts one.
 */
export function anchorable(diff: DiffModel, anchor: Anchor): AnchorCheck {
	const side = sideOf(anchor);
	const file = diff.files.find((entry) => pathOn(entry, side) === anchor.path);
	if (!file) return { anchored: false, reason: "file-absent" };
	if (anchor.subject === "file") return { anchored: true, file };

	const start = anchor.startLine ?? anchor.line;
	if (start > anchor.line) {
		return { anchored: false, reason: "range-inverted" };
	}

	const hunk = hunkHolding(file, side, start);
	if (!hunk) return { anchored: false, reason: "line-absent" };
	if (!lineOn(hunk, side, anchor.line)) {
		// The end line may be absent outright, or present in a
		// later hunk; those are different refusals.
		const reason = hunkHolding(file, side, anchor.line)
			? "range-crosses-hunks"
			: "line-absent";
		return { anchored: false, reason };
	}
	return { anchored: true, file, hunk };
}
