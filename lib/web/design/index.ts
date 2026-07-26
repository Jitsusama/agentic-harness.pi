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
} from "./inventory.js";
export { inventorySource, SAMPLED_PROPERTIES } from "./probe.js";
