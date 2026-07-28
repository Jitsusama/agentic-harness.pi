/**
 * Contrast for text whose background axe declines to judge.
 *
 * A gradient or a photograph defeats the usual reading: there is no
 * single background colour to compare against, so axe reports the
 * element as needing a person. The pixels are available, but they
 * cannot be classified on colour alone, because where contrast is
 * worst the glyph and its background are the same colour by
 * definition, and antialiasing puts blends between the two.
 *
 * What works is a subtraction. Shoot the region, hide the text, shoot
 * it again: the pixels that changed are exactly where the glyphs
 * landed, edges included, and the second shot shows what lies under
 * them. Every ratio here is measured over that mask and no wider, so
 * the answer is about the text a reader has to read rather than about
 * the box it sits in.
 */

import {
	type ContrastLevel,
	isLargeText,
	type TextSizing,
} from "./contrast.js";

/** A decoded region: RGBA, row-major, as a PNG decodes. */
export interface Pixels {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array | Buffer;
}

/** An sRGB colour, as a computed style reports one. */
export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** What the subtraction found. */
export interface BehindReport {
	/** How many pixels the glyphs touched. Zero means nothing to judge. */
	readonly glyphPixels: number;
	/** The worst ratio the text meets anywhere it lands. */
	readonly worstRatio: number;
	/** The ratio the criterion asks of text this size at this bar. */
	readonly required: number;
	readonly verdict: "pass" | "fail" | "undecidable";
	/** Which undecidable this was, when it was one. */
	readonly undecided: "no-text-pixels" | "unreadable-text-colour" | undefined;
	/** Where the worst pixel sat, relative to the region. */
	readonly worstAt: { readonly x: number; readonly y: number } | undefined;
}

/** Relative luminance, per WCAG's definition. */
function luminance(r: number, g: number, b: number): number {
	const channel = (raw: number): number => {
		const s = raw / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio between two luminances, per WCAG. */
function ratio(one: number, other: number): number {
	const [lighter, darker] = one > other ? [one, other] : [other, one];
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Judge text against the background actually behind its glyphs.
 *
 * The two regions must be the same size and the same view: only the
 * text may differ between them. Hiding text is a paint-only change,
 * so nothing moves and the subtraction stays aligned.
 */
export function foldBehind(input: {
	readonly withText: Pixels;
	readonly bare: Pixels;
	readonly textColour: Rgb | undefined;
	readonly sizing: TextSizing;
	readonly bar: ContrastLevel;
}): BehindReport {
	const { withText, bare, textColour, sizing, bar } = input;
	const large = isLargeText(sizing);
	// The four numbers WCAG 1.4.3 and 1.4.6 actually specify.
	const required = bar === "AAA" ? (large ? 4.5 : 7) : large ? 3 : 4.5;

	const width = Math.min(withText.width, bare.width);
	const height = Math.min(withText.height, bare.height);
	const textLum = textColour
		? luminance(textColour.r, textColour.g, textColour.b)
		: undefined;

	let glyphPixels = 0;
	let worstRatio = Number.POSITIVE_INFINITY;
	let worstAt: { x: number; y: number } | undefined;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const inText = (y * withText.width + x) * 4;
			const inBare = (y * bare.width + x) * 4;
			// Any difference at all counts. An antialiased edge can move a
			// single channel by one, and that pixel is still text; a
			// threshold here would quietly stop judging thin glyphs.
			const touched =
				withText.data[inText] !== bare.data[inBare] ||
				withText.data[inText + 1] !== bare.data[inBare + 1] ||
				withText.data[inText + 2] !== bare.data[inBare + 2];
			if (!touched) continue;

			glyphPixels++;
			// The mask is worth building even with no colour to judge
			// against: the count is then a measurement rather than a
			// stand-in for one.
			if (textLum === undefined) continue;
			const behind = ratio(
				textLum,
				luminance(
					bare.data[inBare] ?? 0,
					bare.data[inBare + 1] ?? 0,
					bare.data[inBare + 2] ?? 0,
				),
			);
			if (behind < worstRatio) {
				worstRatio = behind;
				worstAt = { x, y };
			}
		}
	}

	if (glyphPixels === 0) {
		return {
			glyphPixels: 0,
			worstRatio: 0,
			required,
			verdict: "undecidable",
			undecided: "no-text-pixels",
			worstAt: undefined,
		};
	}
	if (textLum === undefined) {
		// The glyphs are there and the background is readable; what is
		// missing is the one colour the ratio needs. Substituting a
		// plausible one would answer confidently about a colour nobody
		// read, which is the failure this whole module exists to avoid.
		return {
			glyphPixels,
			worstRatio: 0,
			required,
			verdict: "undecidable",
			undecided: "unreadable-text-colour",
			worstAt: undefined,
		};
	}
	return {
		glyphPixels,
		worstRatio,
		required,
		verdict: worstRatio >= required ? "pass" : "fail",
		undecided: undefined,
		worstAt,
	};
}

/** How much of the region the glyphs actually covered. */
function glyphArea(pixels: number): string {
	return pixels === 1 ? "1 pixel" : `${pixels} pixels`;
}

/** Render a subtraction as a verdict a reader can act on. */
export function renderBehind(report: BehindReport): string {
	if (report.verdict === "undecidable") {
		const many = glyphArea(report.glyphPixels);
		const why =
			report.undecided === "unreadable-text-colour"
				? `The glyphs are here, covering ${many}, but the text's own ` +
					"colour could not be read, so there is nothing to compare " +
					"the background against. A stylesheet using a colour " +
					"syntax this build cannot parse will do that."
				: "Hiding the text changed no pixels, so there is no text here " +
					"to measure, or it was already invisible.";
		return ["WARN contrast behind the text could not be judged", "", why].join(
			"\n",
		);
	}

	const mark = report.verdict === "pass" ? "PASS" : "FAIL";
	const ratioText = `${report.worstRatio.toFixed(2)}:1`;
	const where = report.worstAt
		? ` Worst at ${report.worstAt.x},${report.worstAt.y} in the region.`
		: "";
	// The pixel count is what keeps the ratio honest: it says the
	// number describes the glyphs rather than the whole box.
	const many = glyphArea(report.glyphPixels);
	return [
		`${mark} worst contrast behind the text is ${ratioText}` +
			`, against ${report.required}:1 required`,
		"",
		`Measured over the ${many} the glyphs cover, against the ` +
			`background underneath them.${where}`,
	].join("\n");
}
