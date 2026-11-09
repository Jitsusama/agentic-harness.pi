/**
 * What a page is built from, and where it drifted from itself.
 *
 * The inventory is pure and capture-agnostic: style samples in,
 * dimensions and clusters out. It works as well on a stored
 * capture or a set of design tokens as on a live page.
 */

export {
	renderInventory,
	type StyleSample,
	takeInventory,
} from "./inventory.ts";
export { inventorySource } from "./probe.ts";
export {
	analyseTypography,
	renderTypography,
	type TextBlock,
	TYPOGRAPHY_CAPTURE,
} from "./typography.ts";
