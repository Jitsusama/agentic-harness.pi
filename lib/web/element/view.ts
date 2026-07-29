/**
 * Laying out what was found about one element.
 *
 * Kept apart from the judging so the two have separate reasons
 * to change: what is true about an element and how it reads are
 * different questions.
 */

import type {
	Declaration,
	PropertyTrace,
	StyleGroup,
} from "../styles/index.js";
import type { BoxModel } from "./box.js";
import type { VisibilityVerdict } from "./visibility.js";

/** Round a measurement to something a person would say. */
function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** The verdict, as a sentence. */
export function renderVisibility(verdict: VisibilityVerdict): string {
	return `${verdict.state}: ${verdict.because}`;
}

/**
 * The boxes, innermost outwards, with the offsets between them
 * stated only where they exist. Four zeroes for the margin of
 * an element with no margin is noise.
 *
 * The position says which space it is measured in. These numbers
 * come from the box model, which measures from the viewport, while
 * a page query reports the same element measured down the document.
 * On a scrolled page the two differ by however far it has moved,
 * and an unlabelled pair of numbers invites reading one as the
 * other: that confusion hid a real defect for hours, because every
 * reading was true in its own frame and none were comparable.
 */
export function renderBox(box: BoxModel): string {
	const lines = [
		`content ${round(box.content.width)} by ${round(box.content.height)}` +
			` at (${round(box.content.x)}, ${round(box.content.y)})` +
			" in the viewport",
	];
	const padding = insetsBetween(box.content, box.padding);
	if (padding) lines.push(`padding ${padding}`);
	const border = insetsBetween(box.padding, box.border);
	if (border) lines.push(`border ${border}`);
	const margin = insetsBetween(box.border, box.margin);
	if (margin) lines.push(`margin ${margin}`);
	return lines.join("\n");
}

/** The gap on each side between an inner and an outer box. */
function insetsBetween(
	inner: { x: number; y: number; width: number; height: number },
	outer: { x: number; y: number; width: number; height: number },
): string | undefined {
	const top = inner.y - outer.y;
	const left = inner.x - outer.x;
	const right = outer.x + outer.width - (inner.x + inner.width);
	const bottom = outer.y + outer.height - (inner.y + inner.height);
	if ([top, right, bottom, left].every((side) => side === 0)) return undefined;
	if (top === right && right === bottom && bottom === left) {
		return round(top);
	}
	if (top === bottom && left === right) return `${round(top)} ${round(right)}`;
	return `${round(top)} ${round(right)} ${round(bottom)} ${round(left)}`;
}

/** Curated styles, grouped as they were curated. */
export function renderStyles(groups: readonly StyleGroup[]): string {
	if (groups.length === 0) return "Nothing was set beyond the defaults.";
	return groups
		.map(
			(group) =>
				`${group.name}\n` +
				group.entries
					.map((entry) => `  ${entry.property}: ${entry.value}`)
					.join("\n"),
		)
		.join("\n");
}

/** One declaration, said the way a person would read it. */
function renderDeclaration(declaration: Declaration, won: boolean): string {
	const mark = won ? "wins " : "     ";
	const value = declaration.important
		? `${declaration.value} !important`
		: declaration.value;

	const where =
		declaration.origin === "inline"
			? "inline style"
			: (declaration.selector ?? declaration.origin);
	const parts = [`${mark} ${declaration.property}: ${value}`, `from ${where}`];
	if (declaration.media) parts.push(`@media ${declaration.media.join(", ")}`);
	if (declaration.origin === "user-agent") parts.push("(browser default)");
	if (declaration.origin === "inherited") parts.push("(inherited)");
	if (declaration.via) parts.push(`via ${declaration.via}`);
	const authored = declaration.source?.authored;
	if (authored) {
		// The authored position is the one worth reading, but the
		// generated line stays beside it: a stale map is a real
		// thing, and hiding the disagreement hides the bug.
		parts.push(`${authored.source}:${authored.line + 1}`);
		if (declaration.source?.line !== undefined) {
			parts.push(`(built line ${declaration.source.line + 1})`);
		}
	} else if (declaration.source?.line !== undefined) {
		parts.push(`line ${declaration.source.line + 1}`);
	}
	return parts.join("  ");
}

/** Everything that had a say in one property, strongest first. */
export function renderTrace(trace: PropertyTrace): string {
	if (trace.declarations.length === 0) {
		return `Nothing declared ${trace.property}.`;
	}
	const heading =
		trace.computed === undefined
			? trace.property
			: `${trace.property} computed to ${trace.computed}`;
	return [
		heading,
		...trace.declarations.map((declaration) =>
			renderDeclaration(declaration, declaration === trace.winner),
		),
	].join("\n");
}
