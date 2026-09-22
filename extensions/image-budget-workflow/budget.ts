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

/**
 * Pixels an image may occupy before it is scaled down.
 *
 * Set from what a human can actually see rather than from a provider
 * maximum. A full-screen capture on a 2x Retina display is 5.94
 * megapixels, and its logical resolution, which is the rendering the
 * human read, is 1.48. So an allowance of 1.5 megapixels preserves any
 * full-screen logical capture exactly while discarding the device-pixel
 * redundancy above it.
 *
 * That makes the common case information-preserving rather than a
 * quality trade, which is what puts this on the safe side of the
 * actuator partition: there is no judgement being economised on.
 */
export const PIXEL_BUDGET = 1_500_000;

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
