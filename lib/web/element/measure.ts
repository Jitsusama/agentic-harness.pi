/**
 * The space between two elements.
 *
 * Most of design review is one question asked over and over: is
 * that gap 16 or 12. Every box needed to answer it was already
 * being read; nothing subtracted them, so the answer came from
 * squinting at a screenshot.
 */

import type { Rect } from "./box.js";

/**
 * How two boxes sit relative to each other on one axis.
 *
 * Three outcomes rather than a signed number. A negative gap
 * reads as a small gap at a glance, and the repair for an overlap
 * is nothing like the repair for a gap that is two pixels out.
 * "spans" is the third because two boxes side by side share every
 * row of pixels vertically: calling that a zero gap sends someone
 * hunting for the margin that closed it.
 */
export interface AxisRelation {
	readonly kind: "gap" | "overlap" | "spans";
	/** How many pixels of gap or of overlap. Zero when spanning. */
	readonly pixels: number;
}

/** How two elements sit relative to each other. */
export interface Measurement {
	readonly horizontal: AxisRelation;
	readonly vertical: AxisRelation;
	/** Edges or centres that line up, named as a designer names them. */
	readonly aligned: readonly string[];
	readonly sameSize: boolean;
	readonly widthDelta: number;
	readonly heightDelta: number;
}

/**
 * Sub-pixel layout is normal and a designer does not mean it.
 *
 * Two edges a thousandth of a pixel apart were meant to line up,
 * and reporting them as misaligned would bury the one case that
 * is a real mistake in noise.
 */
const SAME = 0.5;

/** Measure one axis: the space between two spans on a line. */
function relate(
	startA: number,
	endA: number,
	startB: number,
	endB: number,
): AxisRelation {
	const between = Math.max(startA, startB) - Math.min(endA, endB);
	if (between > 0) return { kind: "gap", pixels: round(between) };

	// They touch or cross. How far they cross is the smaller of the
	// two overhangs, which is the distance one would have to move
	// to clear the other.
	const into = Math.min(endA, endB) - Math.max(startA, startB);
	if (into <= 0) return { kind: "gap", pixels: 0 };

	// One fully inside the other on this axis is the ordinary case
	// for boxes in a row, and is not an overlap anybody wants told.
	const shorter = Math.min(endA - startA, endB - startB);
	if (into >= shorter - SAME) return { kind: "spans", pixels: 0 };
	return { kind: "overlap", pixels: round(into) };
}

/** Pixels, to a tenth, without a trailing zero. */
function round(value: number): number {
	return Math.round(value * 10) / 10;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= SAME;

/** Measure the space between two boxes. */
export function measureBetween(a: Rect, b: Rect): Measurement {
	const horizontal = relate(a.x, a.x + a.width, b.x, b.x + b.width);
	const vertical = relate(a.y, a.y + a.height, b.y, b.y + b.height);

	const aligned: string[] = [];
	if (near(a.x, b.x)) aligned.push("left");
	if (near(a.x + a.width, b.x + b.width)) aligned.push("right");
	if (near(a.y, b.y)) aligned.push("top");
	if (near(a.y + a.height, b.y + b.height)) aligned.push("bottom");
	// A centre line only earns a mention when no edge on that axis
	// already explains the alignment, or every centred pair would
	// be reported three times.
	if (!aligned.includes("left") && !aligned.includes("right")) {
		if (near(a.x + a.width / 2, b.x + b.width / 2)) {
			aligned.push("horizontal centre");
		}
	}
	if (!aligned.includes("top") && !aligned.includes("bottom")) {
		if (near(a.y + a.height / 2, b.y + b.height / 2)) {
			aligned.push("vertical centre");
		}
	}

	const widthDelta = round(Math.abs(a.width - b.width));
	const heightDelta = round(Math.abs(a.height - b.height));

	return {
		horizontal,
		vertical,
		aligned,
		sameSize: widthDelta <= SAME && heightDelta <= SAME,
		widthDelta,
		heightDelta,
	};
}

/** One axis in words. */
function say(relation: AxisRelation, axis: string): string | undefined {
	if (relation.kind === "gap") {
		return `${relation.pixels}px ${axis} between them`;
	}
	if (relation.kind === "overlap") {
		return `they overlap by ${relation.pixels}px ${axis}`;
	}
	return undefined;
}

/**
 * Say what was measured, gap first because that is what was asked.
 */
export function renderMeasurement(
	m: Measurement,
	nameA: string,
	nameB: string,
): string {
	const lines = [`${nameA} and ${nameB}:`];

	const across = say(m.horizontal, "horizontally");
	const down = say(m.vertical, "vertically");
	if (across === undefined && down === undefined) {
		// Both axes spanning means one contains the other, which is
		// worth saying plainly rather than reporting as no news.
		lines.push("  One sits inside the other; there is no gap to measure.");
	}
	if (across !== undefined) lines.push(`  ${across}`);
	if (down !== undefined) lines.push(`  ${down}`);

	if (m.aligned.length > 0) {
		lines.push(`  Lined up on: ${m.aligned.join(", ")}`);
	}

	if (m.sameSize) {
		lines.push("  Same size.");
	} else {
		const parts: string[] = [];
		if (m.widthDelta > SAME) parts.push(`${m.widthDelta}px in width`);
		if (m.heightDelta > SAME) parts.push(`${m.heightDelta}px in height`);
		lines.push(`  Differ by ${parts.join(" and ")}.`);
	}

	return lines.join("\n");
}
