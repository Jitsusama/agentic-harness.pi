/** Target dimensions for an image that exceeds the allowance. */
export interface ImageFit {
	readonly maxWidth: number;
	readonly maxHeight: number;
}

/**
 * Pixels per billed token, as Anthropic prices vision input. This is the
 * fact the whole extension turns on: an image costs what its dimensions
 * cost, not what its payload weighs. Measured against a real response, a
 * 415,508-character base64 image billed 1,789 tokens.
 */
const PIXELS_PER_TOKEN = 750;

/** Default allowance, and the level legibility was checked at. */
const DEFAULT_BUDGET = 1_000_000;

/** The allowance, overridable for a different trade. */
function readBudget(): number {
	const raw = Number(process.env.PI_IMAGE_PIXEL_BUDGET);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET;
}

/**
 * Pixels an image may occupy before it is scaled down, about 1,330
 * billed tokens.
 *
 * Set by reading downscaled screenshots and finding where they stop
 * being legible, rather than by argument. At one megapixel a full
 * window capture of a terminal stays comfortable: body text, command
 * lines, paths and a status line all read cleanly. At 0.6 it is still
 * readable but the smallest row is at the edge of resolvable, which
 * leaves no margin for a denser screenshot, so the floor is set above
 * the point where it was tested to fail.
 *
 * This is a measured quality trade, not a lossless one, and the
 * distinction matters. An earlier allowance of 1.5 megapixels was
 * chosen to match the logical resolution of a 2x Retina display, which
 * made it information-preserving by construction. One megapixel is
 * below that, so it does discard detail a human could in principle
 * have seen. It is justified by evidence that the detail is not needed
 * rather than by the geometry, which is a weaker claim honestly held.
 *
 * Override with PI_IMAGE_PIXEL_BUDGET to trade differently.
 */
export const PIXEL_BUDGET = readBudget();

/** What a provider bills for an image of these dimensions, in tokens. */
export function billedTokens(width: number, height: number): number {
	if (width <= 0 || height <= 0) return 0;
	return Math.round((width * height) / PIXELS_PER_TOKEN);
}

/**
 * Dimensions to scale to, or nothing when the image is already within
 * the allowance.
 *
 * Returning nothing is the common answer and matters: an image left
 * alone is not re-encoded, loses no quality to a second compression,
 * and costs no worker time.
 *
 * Scaling is by a single ratio on both edges, so the aspect ratio is
 * preserved and nothing is stretched. The ratio is never above one,
 * because spending the allowance on an image that does not need it
 * would cost tokens and add no detail the original did not have.
 */
export function fitToBudget(width: number, height: number): ImageFit | null {
	// A non-positive dimension means the decoder reported no size.
	// Building a ratio from it would be arithmetic on a value that means
	// nothing, so the image is left as it is.
	if (width <= 0 || height <= 0) return null;

	const pixels = width * height;
	if (pixels <= PIXEL_BUDGET) return null;

	const ratio = Math.sqrt(PIXEL_BUDGET / pixels);
	// Floor rather than round, so the result is inside the allowance
	// rather than a pixel over it on either edge.
	return {
		maxWidth: Math.max(1, Math.floor(width * ratio)),
		maxHeight: Math.max(1, Math.floor(height * ratio)),
	};
}
