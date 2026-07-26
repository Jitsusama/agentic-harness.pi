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

import { summarizeJson } from "./digest.js";
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
	if (answer.shown >= answer.total) return { text: answer.view };

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
	const held = answer.total.toLocaleString();
	const seen = answer.shown.toLocaleString();
	return (
		`All ${held} ${answer.unit} are stored under handle ${handle}; ` +
		`this answer shows ${seen}. Query the rest with result_query, ` +
		`projecting the fields you want rather than whole records. ` +
		`Shape: ${digest}`
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
		`This answer shows ${answer.shown.toLocaleString()} of ` +
		`${answer.total.toLocaleString()} ${answer.unit}. The remainder ` +
		`could not be stored (${why}), so it is not retrievable: narrow the ` +
		`call to see the rest.`
	);
}
