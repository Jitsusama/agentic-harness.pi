/**
 * What other extensions add to a compaction summary the harness writes.
 *
 * The compaction workflow emits one request per compaction on
 * {@link SUMMARY_CONTRIBUTIONS} before it applies a summary. A listener
 * pushes focus instructions and text to append, synchronously, and keeps
 * the request: once the workflow's `session_before_compact` handler has
 * run, `handled` says whether it wrote the summary, so a listener with a
 * summariser of its own can stand down rather than pay for a second one.
 * `preparation` is the object pi hands every handler of the same
 * compaction, which is how a listener tells this compaction's request
 * from an earlier one.
 *
 * `firstKeptEntryId` is where the verbatim tail of this compaction
 * starts, which can be earlier than pi's own cut when the summary was
 * written ahead: anything a listener quotes from before it is gone from
 * the context, and anything from after it is still there. A request
 * emitted while a summary is only starting to be written ahead has
 * none, since no compaction has chosen one yet.
 *
 * `records` is where a listener says what it did, under its own id: the
 * host keeps it on the compaction entry as `details.contributions`, so
 * a contributor that added nothing can say why rather than go unseen.
 * Use {@link recordContribution}, which tolerates a host from before
 * records existed.
 */

/** The pi.events channel a contribution request is emitted on. */
export const SUMMARY_CONTRIBUTIONS = "compaction:summary-contributions";

/** One compaction's contributions, filled in by listeners. */
export interface SummaryContributions {
	readonly preparation: object;
	readonly instructions: string[];
	readonly appendix: string[];
	/** Where the verbatim tail starts, once a compaction has chosen it. */
	readonly firstKeptEntryId?: string;
	/** What each contributor did, by its id; absent from older hosts. */
	readonly records?: Record<string, unknown>;
	handled: boolean;
}

/** An empty set of contributions for one compaction. */
export function newContributions(
	preparation: object,
	firstKeptEntryId?: string,
): SummaryContributions {
	return {
		preparation,
		instructions: [],
		appendix: [],
		...(firstKeptEntryId ? { firstKeptEntryId } : {}),
		records: {},
		handled: false,
	};
}

/** Whether a pi.events payload is a contribution request. */
export function isSummaryContributions(
	data: unknown,
): data is SummaryContributions {
	if (typeof data !== "object" || data === null) return false;
	const c = data as Record<string, unknown>;
	return (
		typeof c.preparation === "object" &&
		c.preparation !== null &&
		Array.isArray(c.instructions) &&
		Array.isArray(c.appendix) &&
		typeof c.handled === "boolean" &&
		(c.firstKeptEntryId === undefined ||
			typeof c.firstKeptEntryId === "string") &&
		(c.records === undefined ||
			(typeof c.records === "object" && c.records !== null))
	);
}

/**
 * Say what a contributor did with this compaction, under its id. A host
 * from before records existed has nowhere to keep it, and the call does
 * nothing.
 */
export function recordContribution(
	contributions: SummaryContributions,
	id: string,
	record: Readonly<Record<string, unknown>>,
): void {
	if (contributions.records) contributions.records[id] = record;
}
