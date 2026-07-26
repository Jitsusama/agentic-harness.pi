/**
 * Bounding an answer that already carries its own records.
 *
 * Several families hand their structured records to a result's
 * details, because that is what their renderers draw from. Those
 * records are exactly what a caller would query, so nothing new
 * has to be gathered to keep the answer bounded: the view gets
 * cut, and what it was rendered from gets stored.
 *
 * This is deliberately a heuristic over an interface. Retrofitting
 * every handler in every family to declare its collection would be
 * a hundred edit sites and a hundred chances to forget one,
 * whereas the details are already there and already right. Where
 * the heuristic cannot be sure, it does nothing at all.
 */

import { citeListing } from "./listing.js";
import type { ResultStore } from "./store.js";

/** The records a details object carries, when it carries one set. */
export interface DetailRecords {
	readonly items: readonly unknown[];
	/** The key they arrived under, which is their name in the caller's words. */
	readonly unit: string;
}

/**
 * The one collection in a details object, when there is exactly
 * one.
 *
 * List-shaped answers carry a single collection: messages, files,
 * events, locations. Single-subject answers carry none: one
 * channel, one user, one document. Anything with two collections
 * is ambiguous and left alone, because citing the wrong one points
 * a caller's query at a shape that is not there, and a query that
 * silently matches nothing is worse than no handle at all.
 *
 * An empty collection is also nothing to cite. There is no detail
 * behind an answer that found nothing.
 */
export function recordsIn(details: unknown): DetailRecords | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const arrays = Object.entries(details).filter(([, value]) =>
		Array.isArray(value),
	);
	if (arrays.length !== 1) return undefined;
	const [unit, items] = arrays[0] as [string, readonly unknown[]];
	if (items.length === 0) return undefined;
	return { items, unit };
}

/**
 * Bound a rendered answer, citing the records behind it.
 *
 * The narrowing advice is the caller's to supply, because every
 * family narrows differently and advice that names a parameter the
 * tool does not have costs a call to disprove.
 */
export function boundedByDetails(
	store: ResultStore,
	answer: { text: string; details: unknown; narrowing: string },
): string {
	const records = recordsIn(answer.details);
	if (records === undefined) return answer.text;
	return citeListing(store, {
		view: answer.text,
		records: records.items,
		unit: records.unit,
		narrowing: answer.narrowing,
	});
}
