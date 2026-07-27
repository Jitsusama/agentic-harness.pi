/**
 * Deciding whether an answer needs a handle, and saying so.
 *
 * The rule is one sentence: cite a handle exactly when the stored
 * payload holds more than the inline view shows. Both halves of
 * that matter. Citing always would put a line of machinery on
 * answers that are already complete, and train a reader to skip
 * it, which is the same as not printing it. Citing only when asked
 * would require the caller to know in advance that the page was
 * enormous, and that is precisely the thing they called to find
 * out.
 *
 * This lives in one place because every family needs the same
 * decision and none of them should be making it. A tool that
 * decided for itself would drift: one would cite at a kilobyte,
 * another at a megabyte, a third would forget, and the caller
 * would have to learn each one's habits instead of the rule.
 */

import { count } from "./counts.js";
import { summarizeJson } from "./digest.js";
import { queryTool } from "./follow.js";
import type { ResultStore } from "./store.js";

/** What a family knows about the answer it is about to give. */
export interface Citable<T> {
	/** The whole payload, as a structure a query can walk. */
	readonly payload: T;
	/** The bounded text the caller reads first. */
	readonly view: string;
	/**
	 * How much of the payload the view actually shows, and how much
	 * there is. When these agree the view is the whole truth and no
	 * handle is cited.
	 */
	readonly shown: number;
	readonly total: number;
	/** What the units are, for a sentence a human can read. */
	readonly unit: string;
	/**
	 * What the payload holds, when that is a different unit from the
	 * one being counted.
	 *
	 * A listing counts lines, because lines are what the reader can
	 * see and count for themselves, but what gets stored is the
	 * records those lines were rendered from. Without this the
	 * citation says all 797 lines are stored, which is false, and the
	 * family has to append a sentence taking it back. Driving Slack
	 * for real is what surfaced it: the answer claimed lines were
	 * stored and then said the payload was not lines, one after the
	 * other.
	 */
	readonly stored?: { readonly count?: number; readonly unit: string };
	/**
	 * Whether the view omits part of the payload for reasons of its
	 * own, with the counts agreeing.
	 *
	 * The counts answer "did the budget cut this", which is not the
	 * same question as "is this all of it". An audit prints five
	 * elements per rule and a count of the rest: every line it
	 * intended to write got written, so shown equals total, and
	 * without this the handle nobody needs more is the only one
	 * offered while the answer hiding eight thousand elements offers
	 * none.
	 */
	readonly elided?: boolean;
}

/** An answer, with a handle when there is more to be had. */
export interface Cited {
	/** The text to return: the view, and the citation when there is one. */
	readonly text: string;
	/** The handle, when the payload was stored. */
	readonly handle?: string;
	/** Where the payload landed, when it was stored. */
	readonly path?: string;
}

/**
 * Store a payload and cite it when the view does not show all of
 * it.
 *
 * A failure to store is reported rather than thrown, and never
 * costs the caller their answer: the view is what they asked for,
 * the handle is a convenience, and losing a convenience is not
 * worth losing a page read over.
 */
export function cite<T>(store: ResultStore, answer: Citable<T>): Cited {
	if (answer.shown >= answer.total && !answer.elided) {
		return { text: answer.view };
	}

	let stored: { handle: string; path: string };
	try {
		stored = store.put(JSON.stringify(answer.payload));
	} catch (err) {
		return {
			text: `${answer.view}\n\n${unstorable(answer, err)}`,
		};
	}

	const digest = summarizeJson(answer.payload);
	return {
		text: `${answer.view}\n\n${citation(answer, stored.handle, digest)}`,
		handle: stored.handle,
		path: stored.path,
	};
}

/** The sentence that turns a handle into something usable. */
function citation<T>(
	answer: Citable<T>,
	handle: string,
	digest: string,
): string {
	const held = count(answer.total);
	const seen = count(answer.shown);
	const tool = queryTool();
	const rest =
		tool === undefined
			? // Naming a tool that is not loaded is worse than saying
				// nothing: it promises the rest of the data is one call
				// away. The shape still helps a reader decide whether it
				// is worth loading the tool that can read it.
				`No tool in this session can read a handle, so this one ` +
				`cannot be followed; load the result-store-workflow ` +
				`extension to query it. Shape: ${digest}`
			: `Query it with ${tool}, projecting the fields you want ` +
				`rather than whole records. Shape: ${digest}`;
	if (answer.elided && answer.shown >= answer.total) {
		// Nothing was cut, so there is no shortfall in lines to report.
		// Saying "renders 12 of 12 lines" next to a handle would invite
		// the reader to conclude they had already seen everything.
		const what =
			answer.stored?.count === undefined
				? `The whole ${answer.stored?.unit ?? "payload"}`
				: `All ${count(answer.stored.count)} ${answer.stored.unit}`;
		return (
			`${what} are stored under handle ${handle}; this view lists ` +
			`only some of them. ${rest}`
		);
	}
	if (answer.stored !== undefined) {
		// Two different counts, said once each: what is on disk, and how
		// much of the rendering the reader is looking at.
		if (answer.stored.count === undefined) {
			// Nothing countable was identified, so the payload is described
			// rather than counted. Inventing a count of one would read as a
			// single record and send a caller looking for it.
			return (
				`The whole ${answer.stored.unit} is stored under handle ` +
				`${handle}, of which this answer renders ${seen} of ` +
				`${held} ${answer.unit}. ${rest}`
			);
		}
		const kept = count(answer.stored.count);
		return (
			`All ${kept} ${answer.stored.unit} are stored under handle ` +
			`${handle}, of which this answer renders ${seen} of ` +
			`${held} ${answer.unit}. ${rest}`
		);
	}
	return (
		`All ${held} ${answer.unit} are stored under handle ${handle}; ` +
		`this answer shows ${seen}. ${rest}`
	);
}

/**
 * Say that the rest is unreachable, rather than implying it is
 * merely absent.
 *
 * A caller told nothing would reasonably assume the view was
 * everything and reason from a fraction of the data.
 */
function unstorable<T>(answer: Citable<T>, err: unknown): string {
	const why = err instanceof Error ? err.message : String(err);
	return (
		`This answer shows ${count(answer.shown)} of ` +
		`${count(answer.total)} ${answer.unit}. The remainder ` +
		`could not be stored (${why}), so it is not retrievable: narrow the ` +
		`call to see the rest.`
	);
}
