/**
 * Public surface of the refs library.
 *
 * Pluggable registry of external-system reference types
 * (GitHub issues, Slack threads, anything with a URL and a
 * recognisable shape). Consumers register their types; the
 * library extracts matches from text and builds canonical
 * URLs on demand. Built-in types are opt-in via
 * `registerBuiltinRefTypes`.
 */

export {
	getRefType,
	listRefTypes,
	parseAllRefs,
	parseRef,
	urlForRef,
} from "./lookup.js";
export {
	clearRefTypes,
	registerBuiltinRefTypes,
	registerRefType,
	unregisterRefType,
} from "./register.js";
export type { Ref, RefType } from "./types.js";
