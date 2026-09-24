/**
 * What other extensions add to a compaction summary the harness writes.
 *
 * The compaction workflow emits one request per compaction on
 * {@link SUMMARY_CONTRIBUTIONS} before it tries to summarise. A listener
 * pushes focus instructions and text to append, synchronously, and keeps
 * the request: once the workflow's `session_before_compact` handler has
 * run, `handled` says whether it wrote the summary, so a listener with a
 * summariser of its own can stand down rather than pay for a second one.
 * `preparation` is the object pi hands every handler of the same
 * compaction, which is how a listener tells this compaction's request
 * from an earlier one.
 */

/** The pi.events channel a contribution request is emitted on. */
export const SUMMARY_CONTRIBUTIONS = "compaction:summary-contributions";

/** One compaction's contributions, filled in by listeners. */
export interface SummaryContributions {
	readonly preparation: object;
	readonly instructions: string[];
	readonly appendix: string[];
	handled: boolean;
}

/** An empty set of contributions for one compaction. */
export function newContributions(preparation: object): SummaryContributions {
	return { preparation, instructions: [], appendix: [], handled: false };
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
		typeof c.handled === "boolean"
	);
}
