/**
 * Contrast between two elements the caller named.
 *
 * axe judges text against its background and reports the pairs it
 * recognises. What it will not do is answer a question about two
 * elements somebody chose: this icon against that card, this input's
 * border against the page, this focused state against its resting
 * one. Those are 1.4.11 territory, and the machinery for judging them
 * has been here all along with nothing to reach it.
 *
 * Judging is the easy half. Choosing what to compare is where a tool
 * like this earns or loses its trust, so the choice is made by one
 * stated rule and reported alongside the ratio. A caller who
 * disagrees can see exactly what was taken from each side.
 */

import { isOpaque, parseRgb, type Rgba } from "./colour.js";
import {
	type ContrastLevel,
	isLargeText,
	NON_TEXT_MINIMUM,
	type TextSizing,
} from "./contrast.js";

/** What one side of the comparison paints. */
export interface PaintedSide {
	/** Whether it has text of its own, which decides the criterion. */
	readonly hasText: boolean;
	readonly color?: string;
	readonly backgroundColor?: string;
	readonly borderColor?: string;
	/** Needed only when it has text, to know which bar applies. */
	readonly sizing?: TextSizing;
}

/** What the comparison found, and what it was between. */
export interface PairReport {
	/** The property taken from each side, named so it can be argued with. */
	readonly compared: {
		readonly one: string;
		readonly other: string;
	};
	readonly ratio: number;
	readonly required: number;
	/** The success criterion that applies to a pair of this kind. */
	readonly criterion: "1.4.3" | "1.4.11";
	readonly verdict: "pass" | "fail" | "undecidable";
	/** Why it could not decide, when it could not. */
	readonly undecided?: string;
}

/** Relative luminance, per WCAG's definition. */
function luminance(colour: Rgba): number {
	const channel = (raw: number): number => {
		const s = raw / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return (
		0.2126 * channel(colour.r) +
		0.7152 * channel(colour.g) +
		0.0722 * channel(colour.b)
	);
}

/** The contrast ratio between two colours, per WCAG. */
function ratioOf(one: Rgba, other: Rgba): number {
	const [lighter, darker] =
		luminance(one) > luminance(other)
			? [luminance(one), luminance(other)]
			: [luminance(other), luminance(one)];
	return (lighter + 0.05) / (darker + 0.05);
}

/** What was taken from a side, or why nothing could be. */
type Taken =
	| { readonly ok: true; readonly property: string; readonly colour: Rgba }
	| { readonly ok: false; readonly why: string };

/**
 * Take the colour a reader actually sees on this side.
 *
 * The two sides are not interchangeable. The subject is the thing
 * being judged, so its text comes first: an element with text is
 * being read rather than looked at. The surface is what the subject
 * sits against, and its own text is nothing to do with the question,
 * so only what it paints counts. Reading text on both sides compared
 * a heading's colour against a card's inherited colour and reported
 * black on black at 1:1, which is how this rule was found.
 *
 * A see-through colour is not a colour: the thing behind it belongs
 * to an ancestor this cannot name, so it is refused rather than
 * guessed at.
 */
function take(side: PaintedSide, part: "subject" | "surface"): Taken {
	const wanted: readonly (readonly [string, string | undefined])[] =
		part === "subject" && side.hasText
			? [["color", side.color]]
			: [
					["background-color", side.backgroundColor],
					["border-color", side.borderColor],
				];

	for (const [property, stated] of wanted) {
		if (stated === undefined) continue;
		const colour = parseRgb(stated);
		if (!colour) {
			return {
				ok: false,
				why: `its ${property} could not be read, being "${stated}"`,
			};
		}
		// Transparent is worth stepping past rather than failing on,
		// since the next candidate is usually the one doing the work.
		if (!isOpaque(colour)) continue;
		return { ok: true, property, colour };
	}
	return {
		ok: false,
		why: "it paints nothing of its own, so there is no colour to compare",
	};
}

/**
 * Judge two elements against the criterion their pairing implies.
 *
 * Text on one side makes this 1.4.3, whose bar depends on the text
 * size. Two painted surfaces make it 1.4.11, which asks three to one
 * of any boundary a reader has to see.
 */
export function foldPair(input: {
	readonly one: PaintedSide;
	readonly other: PaintedSide;
	readonly bar: ContrastLevel;
}): PairReport {
	const { one, other, bar } = input;
	// The subject decides the criterion. Whether the surface behind it
	// happens to carry text of its own says nothing about what is being
	// judged here.
	const criterion = one.hasText ? "1.4.3" : "1.4.11";
	const large = isLargeText(one.sizing ?? other.sizing ?? DEFAULT_SIZING);
	const required =
		criterion === "1.4.11"
			? NON_TEXT_MINIMUM
			: bar === "AAA"
				? large
					? 4.5
					: 7
				: large
					? 3
					: 4.5;

	const first = take(one, "subject");
	const second = take(other, "surface");
	// Each side is refused on its own, which is what lets the pair
	// below be read as two colours without a cast.
	const undecided = (which: string, why: string): PairReport => ({
		compared: {
			one: first.ok ? first.property : "nothing",
			other: second.ok ? second.property : "nothing",
		},
		ratio: 0,
		required,
		criterion,
		verdict: "undecidable",
		undecided: `${which}: ${why}`,
	});
	if (!first.ok) return undecided("the first element", first.why);
	if (!second.ok) return undecided("the second element", second.why);

	const ratio = ratioOf(first.colour, second.colour);
	return {
		compared: { one: first.property, other: second.property },
		ratio,
		required,
		criterion,
		verdict: ratio >= required ? "pass" : "fail",
	};
}

/** Sizing to assume when neither side stated any. */
const DEFAULT_SIZING: TextSizing = { fontSizePx: 16, fontWeight: 400 };

/** Render a pairing as a verdict a reader can act on. */
export function renderPair(report: PairReport): string {
	if (report.verdict === "undecidable") {
		return [
			"WARN the contrast between these two could not be judged",
			"",
			`Nothing was measured because ${report.undecided}.`,
			"",
			"A see-through colour belongs to whatever is behind it, which " +
				"this cannot name. Point at the element that actually paints " +
				"the surface, or use kind \"contrast\" with 'within' alone to " +
				"measure text against the pixels behind its glyphs.",
		].join("\n");
	}

	const mark = report.verdict === "pass" ? "PASS" : "FAIL";
	const criterion =
		report.criterion === "1.4.3"
			? "1.4.3 contrast of text"
			: "1.4.11 contrast of things that are not text";
	return [
		`${mark} ${report.ratio.toFixed(2)}:1, against ${report.required}:1 ` +
			`required by ${criterion}`,
		"",
		`Measured between the ${report.compared.one} of the first and the ` +
			`${report.compared.other} of the second. Name different elements ` +
			"if that is not the boundary you meant.",
	].join("\n");
}
