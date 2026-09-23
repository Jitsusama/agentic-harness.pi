/**
 * Bounding a re-expanded result.
 *
 * A demoted bash result was, by definition, large enough to be worth
 * cutting in the first place, so handing its full text straight back
 * on `expand_demoted` would just relocate the same cost onto a
 * different call. This is a single-subject answer, not a list, so it
 * takes the `citeWhole` path inside `boundedByDetails`: no records
 * array to cite, the rendering itself is what gets stored.
 */

import {
	boundedByDetails,
	openSessionStore,
} from "@jitsusama/agentic-harness.core/result";

const NARROWING = "Narrow with grep or a targeted read of the recovered text.";

export function boundedExpansion(
	text: string,
	details: { readonly digest: string; readonly found: true },
): string {
	return boundedByDetails(openSessionStore(), {
		text,
		details,
		narrowing: NARROWING,
	});
}
