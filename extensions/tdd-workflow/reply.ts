/**
 * The agent-facing text for a transition attempt.
 *
 * A landed transition and a refused one must be impossible to
 * confuse, because the phase reminders and the refusal guidance
 * deliberately share vocabulary: the `red` reminder ("the failure
 * has to be a real assertion...") reads almost word-for-word like
 * the `green` refusal ("you haven't seen a real red yet..."). The
 * prose alone cannot disambiguate them, so the reply leads with an
 * explicit verdict marker, a tick that advances or a cross that
 * refuses, and names the phase either way. The marker, not the
 * prose, is the contract the agent reads first.
 */

import type { AttestResult } from "@jitsusama/agentic-harness.core/tdd";

/** Leads a landed transition. */
const ADVANCE_MARKER = "✓";
/** Leads a refused transition. */
const REFUSE_MARKER = "✗";

/**
 * Render the reply for an attested transition. An advance names
 * the new phase and carries its standing discipline as the
 * reminder; a refusal names the phase that held and carries
 * core/tdd's guidance unchanged.
 */
export function formatTransitionReply(result: AttestResult): string {
	if (result.outcome === "advanced") {
		return `${ADVANCE_MARKER} Advanced to ${result.loop.phase}. Discipline: ${result.discipline}`;
	}
	return `${REFUSE_MARKER} Refused, still in ${result.loop.phase}, nothing changed. ${result.guidance}`;
}
