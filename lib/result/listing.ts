/**
 * A rendered listing, bounded for reading and stored for querying.
 *
 * Families render their own listings, and they should: a renderer
 * that silently dropped rows would be lying in its own way.
 * Bounding belongs here instead, at the point where the records
 * are still to hand and can be kept.
 *
 * The counts in the citation are lines, because lines are what a
 * reader can see and count for themselves. How many records those
 * lines covered is not knowable from the text, and a citation
 * nobody can check is a citation nobody should trust. What the
 * payload actually holds is named separately, since a caller
 * writing their first expression against lines when the payload
 * holds records gets nothing back and no clue why.
 */

import { cite } from "./cite.js";
import { count } from "./counts.js";
import type { ResultStore } from "./store.js";
import { withinLineBudget } from "./view.js";

/** What a rendered listing spends before the rest is stored. */
export const LISTING_BUDGET_BYTES = 8_192;

/** A listing, and the records behind it. */
export interface Listing<T> {
	/** The rendered view, however long it came out. */
	readonly view: string;
	/** The records the view was rendered from. */
	readonly records: readonly T[];
	/** What the records are, in the caller's words. */
	readonly unit: string;
	/** How to ask for less, in this kind's own vocabulary. */
	readonly narrowing: string;
	readonly budget?: number;
}

/**
 * Bound a listing and cite its records when the view was cut.
 *
 * A listing that fits is returned untouched, with no citation and
 * no advice: the view is the whole truth and saying more would be
 * noise.
 */
export function citeListing<T>(
	store: ResultStore,
	listing: Listing<T>,
): string {
	const budget = listing.budget ?? LISTING_BUDGET_BYTES;
	const bounded = withinLineBudget(listing.view, budget);
	if (bounded.cut === 0) return bounded.text;

	if (listing.records.length === 0) {
		// A caller whose view was cut needs the rest of it, and an empty
		// array is not the rest of it. "All 0 findings are stored under
		// handle X" invites a query that can only come back empty, and
		// reads as though the answer were empty rather than the payload
		// being the wrong thing to have kept.
		return cite(store, {
			payload: listing.view,
			view:
				`${bounded.text}\n\n` +
				`Cut ${count(bounded.cut)} of ${count(bounded.total)} lines ` +
				`to fit the ${count(budget)} byte budget. ${listing.narrowing}`,
			shown: bounded.shown,
			total: bounded.total,
			unit: "lines",
			stored: { unit: "rendered answer" },
		}).text;
	}

	const cited = cite(store, {
		payload: listing.records,
		view:
			`${bounded.text}\n\n` +
			`Cut ${count(bounded.cut)} of ` +
			`${count(bounded.total)} lines to fit the ` +
			`${count(budget)} byte budget. ${listing.narrowing}`,
		shown: bounded.shown,
		total: bounded.total,
		unit: "lines",
		// Lines are what the reader can count; records are what is on
		// disk. Naming both in one sentence replaced a correction
		// appended after the fact, which contradicted the sentence above
		// it and made the reader decide which to believe.
		stored: { count: listing.records.length, unit: listing.unit },
	});
	return cited.text;
}
