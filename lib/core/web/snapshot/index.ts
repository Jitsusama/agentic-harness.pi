/**
 * The page flattened into one addressable list, and the
 * questions worth asking of it.
 */

// The page-side traversal every capture shares, so a probe sees
// the page the snapshot sees rather than only the top document.
export {
	flattenSnapshot,
	type IndexedNode,
	isElement,
	type RawSnapshot,
} from "./flatten.ts";
export {
	describeNode,
	describeStyles,
	find,
	type Query,
	tally,
} from "./query.ts";
