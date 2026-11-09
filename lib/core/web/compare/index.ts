/**
 * Comparing a page against a baseline of itself.
 *
 * Only the region logic is exported here, and that is the point:
 * it is pure, it works on any change mask whatever produced one,
 * and importing it must not drag in a PNG decoder. Somebody
 * clustering a diff they already have should not pay for
 * pixelmatch and pngjs to do it.
 *
 * The image half lives in ./images.js and is imported directly
 * by the session, which is already holding a browser open and
 * has no purity left to protect.
 */

export {
	type Comparison,
	renderComparison,
} from "./regions.ts";
