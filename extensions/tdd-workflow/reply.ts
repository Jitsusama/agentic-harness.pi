/**
 * The agent-facing text for a transition attempt.
 *
 * A landed transition and a refused one must be impossible to
 * confuse, because the phase reminders and the refusal guidance
 * deliberately share vocabulary: the `red` reminder ("the failure
 * has to be a real assertion…") reads almost word-for-word like
 * the `green` refusal ("you haven't seen a real red yet…"). The
 * prose alone cannot disambiguate them, so the reply leads with an
 * explicit verdict marker — a tick that advances, a cross that
 * refuses — and names the phase either way. The marker, not the
 * prose, is the contract the agent reads first.
 */

import { disciplineFor } from "./discipline.js";
import type { Phase, TransitionResult } from "./machine.js";

/** Leads a landed transition. */
const ADVANCE_MARKER = "✓";
/** Leads a refused transition. */
const REFUSE_MARKER = "✗";

/**
 * Render the reply for a transition attempt. A success advances
 * into `result.state.phase` and carries that phase's standing
 * discipline as the reminder; a refusal names the phase that held
 * (`refusedPhase`) and carries the machine's guidance unchanged.
 */
export function formatTransitionReply(
	result: TransitionResult,
	refusedPhase?: Phase,
): string {
	if (result.ok) {
		const phase = result.state.phase;
		return `${ADVANCE_MARKER} Advanced to ${phase}. Discipline: ${disciplineFor(phase)}`;
	}
	const held = refusedPhase ?? "the current phase";
	return `${REFUSE_MARKER} Refused — still in ${held}, nothing changed. ${result.guidance}`;
}
