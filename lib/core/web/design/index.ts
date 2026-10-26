/**
 * What a page is built from, and where it drifted from itself.
 *
 * The inventory is pure and capture-agnostic: style samples in,
 * dimensions and clusters out. It works as well on a stored
 * capture or a set of design tokens as on a live page.
 */

export {
	type Cluster,
	COLOUR_SAMENESS,
	canonicalLengths,
	clusterUsage,
	coloursAreNear,
	DIMENSIONS,
	type Dimension,
	exactlyEqual,
	LENGTH_SAMENESS,
	lengthsAreNear,
	type Nearness,
	renderInventory,
	type StyleSample,
	takeInventory,
	tallyUsage,
	type Usage,
} from "./inventory.ts";
export { inventorySource, SAMPLED_PROPERTIES } from "./probe.ts";
export {
	analyseTypography,
	BODY_FLOOR_CHARS,
	RUNT_MAX_WORDS,
	RUNT_WIDTH_SHARE,
	renderTypography,
	type TextBlock,
	TYPOGRAPHY_CAPTURE,
	type TypographyFinding,
} from "./typography.ts";
