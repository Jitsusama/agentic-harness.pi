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

	const cited = cite(store, {
		payload: listing.records,
		view:
			`${bounded.text}\n\n` +
			`Cut ${bounded.cut.toLocaleString()} of ` +
			`${bounded.total.toLocaleString()} lines to fit the ` +
			`${budget.toLocaleString()} byte budget. ${listing.narrowing}`,
		shown: bounded.shown,
		total: bounded.total,
		unit: "lines",
	});
	if (cited.handle === undefined) return cited.text;
	return (
		`${cited.text}\nThe payload is the ` +
		`${listing.records.length.toLocaleString()} ${listing.unit} ` +
		`themselves, not these lines.`
	);
}
