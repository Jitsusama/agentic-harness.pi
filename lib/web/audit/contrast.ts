/**
 * Judging contrast against WCAG's thresholds.
 *
 * The arithmetic is in colour.ts; this is the part that says
 * what counts as enough, which depends on how big the text is
 * and which level is being held to.
 *
 * A judgment can also decline. A gradient, a background image
 * or a background nobody could determine is not a failure and
 * not a pass: it is a case where the honest answer is that a
 * person has to look. Reporting those as passes is how an
 * automated audit becomes a liability.
 */

import { contrastRatio, formatRgb, type Rgba } from "./colour.js";

/** Which WCAG conformance level a judgment is held to. */
export type ContrastLevel = "AA" | "AAA";

/** Text at or above this size counts as large. */
export const LARGE_TEXT_PX = 24;

/** Bold text at or above this size counts as large: 14pt. */
export const LARGE_BOLD_PX = 18.66;

/** The weight at which text is bold for sizing purposes. */
export const BOLD_WEIGHT = 700;

/** 1.4.3 Contrast (Minimum), normal and large text. */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/** 1.4.6 Contrast (Enhanced). */
const AAA_NORMAL = 7;
const AAA_LARGE = 4.5;

/** 1.4.11 Non-text Contrast, for controls and meaningful graphics. */
export const NON_TEXT_MINIMUM = 3;

/** How text is set, which decides which threshold applies. */
export interface TextSizing {
	readonly fontSizePx: number;
	readonly fontWeight: number;
}

/**
 * Whether text is large enough for the relaxed threshold.
 *
 * The bold cutoff is 14pt against 18pt for normal, which is
 * 18.66px against 24px once points become CSS pixels.
 */
export function isLargeText(sizing: TextSizing): boolean {
	return sizing.fontWeight >= BOLD_WEIGHT
		? sizing.fontSizePx >= LARGE_BOLD_PX
		: sizing.fontSizePx >= LARGE_TEXT_PX;
}

/** The ratio text of this size must reach at this level. */
export function textThreshold(
	sizing: TextSizing,
	level: ContrastLevel,
): number {
	const large = isLargeText(sizing);
	if (level === "AAA") return large ? AAA_LARGE : AAA_NORMAL;
	return large ? AA_LARGE : AA_NORMAL;
}

/** What a contrast judgment concluded. */
export type ContrastVerdict =
	| {
			readonly kind: "judged";
			readonly ratio: number;
			readonly required: number;
			readonly passes: boolean;
			readonly level: ContrastLevel;
			readonly foreground: Rgba;
			readonly background: Rgba;
			readonly large: boolean;
	  }
	| {
			readonly kind: "undecidable";
			/** Why nobody could say, in words a person can act on. */
			readonly because: string;
	  };

/** Judge text against the threshold for its size. */
export function judgeText(input: {
	readonly foreground: Rgba;
	readonly background: Rgba;
	readonly sizing: TextSizing;
	readonly level?: ContrastLevel;
}): ContrastVerdict {
	const level = input.level ?? "AA";
	const required = textThreshold(input.sizing, level);
	return judged(input.foreground, input.background, required, level, {
		large: isLargeText(input.sizing),
	});
}

/**
 * Judge a control's own colours, where size never relaxes it.
 *
 * A focus ring, a checkbox border and an icon that carries
 * meaning are all held to 3:1 regardless of how big they are.
 */
export function judgeNonText(input: {
	readonly foreground: Rgba;
	readonly background: Rgba;
}): ContrastVerdict {
	return judged(input.foreground, input.background, NON_TEXT_MINIMUM, "AA", {
		large: false,
	});
}

/** Rounded the way the ratio is always quoted. */
const RATIO_PLACES = 100;

function judged(
	foreground: Rgba,
	background: Rgba,
	required: number,
	level: ContrastLevel,
	extra: { readonly large: boolean },
): ContrastVerdict {
	const exact = contrastRatio(foreground, background);
	// Reported rounded, judged exact.
	//
	// Rounding before the comparison passed 4.4951 as AA, which is
	// leniency in the one module that must not have any: it
	// disagrees with axe on the same pair inside the same report,
	// and the direction of the error is always to approve. A ratio
	// that reads 4.5 and fails is worth one line of explanation;
	// a failure reported as a pass is not worth anything.
	const ratio = Math.round(exact * RATIO_PLACES) / RATIO_PLACES;
	return {
		kind: "judged",
		ratio,
		required,
		passes: exact >= required,
		level,
		foreground,
		background,
		large: extra.large,
	};
}

/** Decline to judge, and say why. */
export function undecidable(because: string): ContrastVerdict {
	return { kind: "undecidable", because };
}

/** Say what the judgment was. */
export function renderContrast(verdict: ContrastVerdict): string {
	if (verdict.kind === "undecidable") {
		return `Contrast could not be determined: ${verdict.because}`;
	}
	const { ratio, required, passes, level, foreground, background } = verdict;
	const size = verdict.large ? "large text" : "normal text";
	const outcome = passes ? "meets" : "falls short of";
	return (
		`${ratio}:1 ${outcome} the ${required}:1 ${level} minimum for ` +
		`${size}. ${formatRgb(foreground)} on ${formatRgb(background)}`
	);
}
