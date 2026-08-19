/**
 * Bounding a Slack answer without losing what it was rendered
 * from.
 *
 * Slack is the family where this matters most after the browser. A
 * DM history asked for with no limit is every message in the
 * window, and this extension's own guidance tells the model to do
 * exactly that rather than draw conclusions from a partial read.
 * That advice was right and expensive. Now it is only right: the
 * view is bounded, and every message stays queryable.
 *
 * The rule and the heuristic are shared; what belongs to Slack is
 * knowing how a caller asks for less.
 */

import {
	boundedByDetails,
	openSessionStore,
} from "@jitsusama/agentic-harness.core/result";

/** How a caller asks Slack for a smaller answer. */
const NARROWING =
	"Narrow with 'limit', a date range through 'oldest' and 'latest', " +
	"or a tighter search query.";

/**
 * Bound a rendered answer, citing its records when the view was
 * cut.
 *
 * An answer with nothing list-shaped behind it passes through
 * untouched: there would be nothing to query, and a handle
 * pointing at one channel's metadata is machinery for its own sake.
 */
export function boundedAnswer(content: string, details: unknown): string {
	return boundedByDetails(openSessionStore(), {
		text: content,
		details,
		narrowing: NARROWING,
	});
}
