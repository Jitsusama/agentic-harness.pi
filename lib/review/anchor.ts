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

/**
 * A remark about the change as a whole.
 *
 * Its shape, its scope, the commit it sits on, whether it should
 * be one change or three: things a reviewer says about the work
 * rather than about a line of it. There is no place in a diff for
 * one, which is the point. Naming it lets a backend that has
 * somewhere to put it do so, and lets the rest spill it into the
 * review body knowing why.
 */
export interface ChangeAnchor {
	subject: "change";
	witness?: string;
}

/** Where a remark attaches. */
export type Anchor = LineAnchor | FileAnchor | ChangeAnchor;

/** An anchor that names somewhere in the tree. */
type PathAnchor = LineAnchor | FileAnchor;

/** Why an anchor cannot land on a diff. */
export type AnchorRefusal =
	| "file-absent"
	| "line-absent"
	| "range-inverted"
	| "range-crosses-hunks"
	/** The remark named no place, so there is none to find. */
	| "not-a-place";

/** Whether an anchor lands, and what it landed on. */
export type AnchorCheck =
	| { anchored: true; file: DiffFile; hunk?: DiffHunk }
	| { anchored: false; reason: AnchorRefusal };

/** The path an anchor names, when it names one. */
export function anchorPath(anchor: Anchor): string | undefined {
	return anchor.subject === "change" ? undefined : anchor.path;
}

/**
 * Where a remark points, in a form a person can scan.
 *
 * One spelling, because an anchor read four different ways in
 * four views is four chances to describe the same place
 * differently.
 */
export function describeAnchor(anchor: Anchor): string {
	if (anchor.subject === "change") return "the change as a whole";
	if (anchor.subject === "file") return anchor.path;
	const lines =
		anchor.startLine && anchor.startLine !== anchor.line
			? `${anchor.startLine}-${anchor.line}`
			: `${anchor.line}`;
	return `${anchor.path}:${lines}`;
}

/** The side an anchor names, defaulting to the new side. */
function sideOf(anchor: PathAnchor): DiffSide {
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
	// Asked of a remark that named no place, the honest answer is
	// that there was nothing to look for. Falling through to the
	// path lookup would blame a file the remark never mentioned.
	if (anchor.subject === "change") {
		return { anchored: false, reason: "not-a-place" };
	}

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
