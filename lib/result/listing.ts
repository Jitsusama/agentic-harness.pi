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
	/**
	 * A line or two that must survive the cut.
	 *
	 * Some views end with the thing the caller needs in order to
	 * carry on: a cursor to read from next, a note that entries were
	 * dropped. Those sit at the end, which is exactly what a
	 * leading-lines budget removes, so the announcement stream lost
	 * its cursor and its overflow warning together and said nothing
	 * about either. Kept apart from the records because it is not a
	 * record, and appended after the cut rather than counted into it.
	 */
	readonly trailer?: string;
	/**
	 * Whether the view leaves records out on its own account.
	 *
	 * The budget is not the only thing that elides. An audit report
	 * lists five elements per rule and says "and 7,995 more", which
	 * fits any budget comfortably and is missing almost everything.
	 * Keying the citation on the cut alone meant the answer with the
	 * most left out was the one answer that offered no way to reach
	 * it.
	 */
	readonly elided?: boolean;
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
	const trailer = listing.trailer ? `\n\n${listing.trailer}` : "";
	if (bounded.cut === 0 && !listing.elided) {
		return `${bounded.text}${trailer}`;
	}

	if (listing.records.length === 0) {
		// A caller whose view was cut needs the rest of it, and an empty
		// array is not the rest of it. "All 0 findings are stored under
		// handle X" invites a query that can only come back empty, and
		// reads as though the answer were empty rather than the payload
		// being the wrong thing to have kept.
		return cite(store, {
			payload: listing.view,
			view:
				`${bounded.text}${trailer}\n\n` +
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
			`${bounded.text}${trailer}\n\n` +
			(bounded.cut === 0
				? `This view lists only some of what was found. ${listing.narrowing}`
				: `Cut ${count(bounded.cut)} of ` +
					`${count(bounded.total)} lines to fit the ` +
					`${count(budget)} byte budget. ${listing.narrowing}`),
		shown: bounded.shown,
		total: bounded.total,
		unit: "lines",
		...(listing.elided ? { elided: true } : {}),
		// Lines are what the reader can count; records are what is on
		// disk. Naming both in one sentence replaced a correction
		// appended after the fact, which contradicted the sentence above
		// it and made the reader decide which to believe.
		stored: { count: listing.records.length, unit: listing.unit },
	});
	return cited.text;
}
