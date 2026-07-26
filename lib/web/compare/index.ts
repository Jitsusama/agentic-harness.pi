/**
 * Comparing a page against a baseline of itself.
 *
 * The region logic is pure and works on any change mask,
 * whatever produced it. Only the image module needs a decoder.
 */

export {
	compareImages,
	type DiffResult,
	MATCH_THRESHOLD,
	readPng,
} from "./images.js";
export {
	type AttributedRegion,
	attributeRegions,
	CELL_SIZE,
	type Comparison,
	clusterRegions,
	IGNORABLE_FRACTION,
	MIN_REGION_PIXELS,
	type Placed,
	type Region,
	renderComparison,
} from "./regions.js";
