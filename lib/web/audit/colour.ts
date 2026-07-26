/**
 * Colour arithmetic for accessibility judgments.
 *
 * Deliberately narrow. This module does the arithmetic WCAG
 * specifies and nothing else: it does not know what oklch is,
 * how display-p3 clamps into sRGB, or what colour-mix resolves
 * to. Chrome returns modern colour syntax from getComputedStyle
 * unconverted, and converting it here would mean reimplementing
 * colour science that the renderer already does exactly.
 *
 * So the session asks the browser to paint a colour and reads
 * the pixel back, and everything below works in sRGB bytes.
 */

/** A colour in sRGB, channels 0 to 255 and alpha 0 to 1. */
export interface Rgba {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

/** The threshold WCAG names, which is not the sRGB spec's. */
const LINEAR_CUTOFF = 0.03928;
const LINEAR_DIVISOR = 12.92;
const GAMMA_OFFSET = 0.055;
const GAMMA_SCALE = 1.055;
const GAMMA_EXPONENT = 2.4;

/** How much each channel contributes to perceived lightness. */
const RED_WEIGHT = 0.2126;
const GREEN_WEIGHT = 0.7152;
const BLUE_WEIGHT = 0.0722;

/** Keeps a ratio finite when both colours are pure black. */
const RATIO_OFFSET = 0.05;

const CHANNEL_MAX = 255;

function linearize(channel: number): number {
	const scaled = channel / CHANNEL_MAX;
	return scaled <= LINEAR_CUTOFF
		? scaled / LINEAR_DIVISOR
		: ((scaled + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA_EXPONENT;
}

/**
 * How much light a colour reflects, by WCAG's definition.
 *
 * Alpha is ignored, because a translucent colour has no
 * luminance of its own: composite it over something first.
 */
export function relativeLuminance(colour: Rgba): number {
	return (
		RED_WEIGHT * linearize(colour.r) +
		GREEN_WEIGHT * linearize(colour.g) +
		BLUE_WEIGHT * linearize(colour.b)
	);
}

/**
 * The contrast between two colours, from 1 to 21.
 *
 * Order does not matter: the lighter colour always goes on top
 * of the fraction, so a light-on-dark pair reads the same as its
 * reverse.
 */
export function contrastRatio(one: Rgba, other: Rgba): number {
	const a = relativeLuminance(one);
	const b = relativeLuminance(other);
	const lighter = Math.max(a, b);
	const darker = Math.min(a, b);
	return (lighter + RATIO_OFFSET) / (darker + RATIO_OFFSET);
}

/**
 * Paint one colour over another and say what results.
 *
 * This is source-over compositing, the same operation the
 * renderer performs, and it is what makes a translucent
 * foreground judgeable at all.
 */
export function composite(over: Rgba, under: Rgba): Rgba {
	if (over.a >= 1) return over;
	if (over.a <= 0) return under;
	const alpha = over.a + under.a * (1 - over.a);
	if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
	const blend = (top: number, bottom: number) =>
		Math.round((top * over.a + bottom * under.a * (1 - over.a)) / alpha);
	return {
		r: blend(over.r, under.r),
		g: blend(over.g, under.g),
		b: blend(over.b, under.b),
		a: alpha,
	};
}

/** Whether a colour hides whatever is behind it. */
export function isOpaque(colour: Rgba): boolean {
	return colour.a >= 1;
}

/** Whether a colour shows everything behind it. */
export function isTransparent(colour: Rgba): boolean {
	return colour.a <= 0;
}

const RGB_PATTERN =
	/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/;

/**
 * Read the one colour syntax the browser reliably produces.
 *
 * getComputedStyle serializes most colours as rgb() or rgba(),
 * and returns anything else, oklch and color() among them, as
 * written. Those are not guessed at here: an unrecognised
 * syntax returns nothing so the caller can ask the browser to
 * resolve it rather than get a confidently wrong answer.
 */
export function parseRgb(css: string): Rgba | undefined {
	const found = RGB_PATTERN.exec(css.trim());
	if (!found) return undefined;
	const [, red, green, blue, alpha] = found;
	const channel = (text: string | undefined) => Number(text ?? "0");
	const opacity =
		alpha === undefined
			? 1
			: alpha.endsWith("%")
				? Number(alpha.slice(0, -1)) / 100
				: Number(alpha);
	const colour = {
		r: channel(red),
		g: channel(green),
		b: channel(blue),
		a: opacity,
	};
	return Object.values(colour).some(Number.isNaN) ? undefined : colour;
}

/** Say a colour the way CSS would. */
export function formatRgb(colour: Rgba): string {
	return isOpaque(colour)
		? `rgb(${colour.r}, ${colour.g}, ${colour.b})`
		: `rgba(${colour.r}, ${colour.g}, ${colour.b}, ${
				Math.round(colour.a * 1000) / 1000
			})`;
}

/**
 * How far apart two colours look, as CIE76 delta E.
 *
 * Contrast is not a measure of sameness. It compares relative
 * luminance only, so it is blind to hue by construction: pure
 * red and a mid grey differ by a contrast ratio of about 1.001,
 * which any threshold for "these look the same" will accept.
 * That is the right answer to "can text be read on this" and the
 * wrong answer to "are these one colour".
 *
 * Delta E is the measure for the second question. Roughly, 1 is
 * the smallest difference an eye can catch under ideal
 * conditions, 2 to 3 is a just-noticeable difference in
 * practice, and anything past about 10 reads as two colours.
 *
 * CIE76 rather than CIEDE2000: it is a plain Euclidean distance
 * in Lab, it is close enough at the small distances this is used
 * for, and it can be read and checked by anyone.
 */
export function deltaE(one: Rgba, other: Rgba): number {
	const [l1, a1, b1] = toLab(one);
	const [l2, a2, b2] = toLab(other);
	return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** D65, the white point sRGB is defined against. */
const WHITE = { x: 0.95047, y: 1, z: 1.08883 } as const;

/** The knee in the Lab transfer function. */
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

/** sRGB to CIELAB, by way of XYZ. */
function toLab(colour: Rgba): [number, number, number] {
	const r = linearize(colour.r);
	const g = linearize(colour.g);
	const b = linearize(colour.b);

	const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE.x;
	const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / WHITE.y;
	const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE.z;

	const f = (value: number): number =>
		value > LAB_EPSILON ? Math.cbrt(value) : (LAB_KAPPA * value + 16) / 116;

	const fx = f(x);
	const fy = f(y);
	const fz = f(z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
