/**
 * Where an accessible name came from.
 *
 * Two controls can read identically in an outline and be very
 * different to use. A field named by its label is announced
 * whenever it takes focus; one named only by its placeholder
 * loses its name the moment someone types. Knowing the
 * mechanism is what lets a review tell those apart.
 */

import type { RawAxNameSource, RawAxNode } from "./tree.js";

/** The mechanism that produced an element's accessible name. */
export type NameSource =
	| "labelledby"
	| "label"
	| "nativeLabel"
	| "content"
	| "title"
	| "placeholder"
	| "alt"
	| "value"
	| "unnamed";

/** Names that vanish exactly when a user needs them. */
const WEAK_SOURCES: ReadonlySet<NameSource> = new Set(["title", "placeholder"]);

/**
 * Which mechanism produced this node's name.
 *
 * Chrome reports every mechanism it tried, in priority order,
 * marking the ones it passed over. The one that named the
 * element is the one that yielded text and was neither
 * superseded nor pointed at something absent.
 */
export function nameSource(node: RawAxNode): NameSource {
	const winner = (node.name?.sources ?? []).find(produced);
	if (!winner) return "unnamed";

	if (winner.nativeSource) return "nativeLabel";
	if (winner.type === "contents") return "content";
	if (winner.type === "placeholder") return "placeholder";

	switch (winner.attribute) {
		case "aria-labelledby":
			return "labelledby";
		case "aria-label":
			return "label";
		case "title":
			return "title";
		case "alt":
			return "alt";
		case "value":
			return "value";
		default:
			return winner.type === "relatedElement" ? "labelledby" : "unnamed";
	}
}

/** Whether this source actually supplied the name. */
function produced(source: RawAxNameSource): boolean {
	if (source.superseded || source.invalid) return false;
	const text = source.value?.value;
	return text !== undefined && text !== "";
}

/** Whether a name is one that disappears when it is needed most. */
export function isWeakName(source: NameSource): boolean {
	return WEAK_SOURCES.has(source);
}
