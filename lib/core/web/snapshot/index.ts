/**
 * The page flattened into one addressable list, and the
 * questions worth asking of it.
 */

// The page-side traversal every capture shares, so a probe sees
// the page the snapshot sees rather than only the top document.
export { DEEP_DOM, DEEP_UNREACHABLE } from "./deep.ts";
export {
	type Bounds,
	flattenSnapshot,
	type IndexedNode,
	isElement,
	isText,
	type RareValues,
	type RawDocument,
	type RawLayout,
	type RawNodes,
	type RawSnapshot,
} from "./flatten.ts";
export { HIDDEN_BOX_PX, PRESENTED } from "./presented.ts";
export {
	describeNode,
	describeStyles,
	find,
	matches,
	type Query,
	type Tally,
	tally,
} from "./query.ts";
