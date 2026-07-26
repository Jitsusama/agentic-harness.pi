/**
 * The page flattened into one addressable list, and the
 * questions worth asking of it.
 */

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
} from "./flatten.js";
export {
	describeNode,
	find,
	matches,
	type Query,
	type Tally,
	tally,
} from "./query.js";
