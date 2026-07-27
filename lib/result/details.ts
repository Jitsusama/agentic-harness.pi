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
 * whereas the details are already there and already right.
 *
 * What the heuristic decides is only what to call the payload, not
 * whether to keep one. It used to decide both, and a seam whose
 * shape it did not recognize returned its answer whole at any
 * length: the quest verbs nest their rows under a listing key, so
 * nothing at the top level was an array and the bounding never
 * ran. The gate said that family was wired, because it was, and
 * being wired turned out to be a different claim from working.
 *
 * The payload is now the whole details object rather than the one
 * collection inside it. A document read renders its body and
 * carries its comments alongside; storing only the comments cited
 * the one part that had not been cut.
 */

import { cite } from "./cite.js";
import { count } from "./counts.js";
import { citeListing, LISTING_BUDGET_BYTES } from "./listing.js";
import type { ResultStore } from "./store.js";
import { withinLineBudget } from "./view.js";

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
	if (records !== undefined && rendersTheRecords(answer.details)) {
		return citeListing(store, {
			view: answer.text,
			records: records.items,
			unit: records.unit,
			narrowing: answer.narrowing,
		});
	}
	return citeWhole(store, answer, records);
}

/**
 * Whether the details are the collection, rather than carrying one
 * among other things.
 *
 * A listing's details are its records and the paging around them.
 * A document's details are a file, its body and its comments, and
 * the comments are not what the view rendered. Only the first can
 * be cited as though the collection were the answer.
 */
function rendersTheRecords(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	return Object.values(details).every(
		(value) => Array.isArray(value) || typeof value !== "object",
	);
}

/**
 * Bound the view and keep everything behind it.
 *
 * Used where the records cannot be picked out with confidence.
 * Keeping the whole details is the conservative choice: whatever
 * the view was rendered from is somewhere in there, so the cut is
 * recoverable even though the query has to start a level higher.
 * When there is nothing structured at all, the rendering itself is
 * what would be lost, so the rendering is what is kept.
 */
function citeWhole(
	store: ResultStore,
	answer: { text: string; details: unknown; narrowing: string },
	records: DetailRecords | undefined,
): string {
	const bounded = withinLineBudget(answer.text, LISTING_BUDGET_BYTES);
	if (bounded.cut === 0) return bounded.text;

	const hasDetails =
		typeof answer.details === "object" &&
		answer.details !== null &&
		Object.keys(answer.details).length > 0;
	return cite(store, {
		payload: hasDetails ? answer.details : answer.text,
		view:
			`${bounded.text}\n\n` +
			`Cut ${count(bounded.cut)} of ` +
			`${count(bounded.total)} lines to fit the ` +
			`${count(LISTING_BUDGET_BYTES)} byte budget. ` +
			answer.narrowing,
		shown: bounded.shown,
		total: bounded.total,
		unit: "lines",
		stored: records
			? { count: records.items.length, unit: records.unit }
			: { unit: hasDetails ? "result detail" : "rendered answer" },
	}).text;
}
