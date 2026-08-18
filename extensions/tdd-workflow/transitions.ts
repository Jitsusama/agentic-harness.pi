/**
 * The persistent context the agent carries between turns: just
 * where the loop is. It wraps core/tdd's standingReminder in pi's
 * message envelope. It deliberately does not re-issue the phase
 * discipline every turn; that reminder rides the transition
 * reply, at the moment the agent asks for it. A companion filter
 * strips this context once the loop is no longer active.
 */

import { standingReminder } from "@jitsusama/agentic-harness.core/tdd";
import { filterContext } from "../../lib/internal/state.js";
import type { TddState } from "./state.js";

/** The customType tag for the injected TDD context message. */
const CONTEXT_TYPE = "tdd-workflow-context";

/** Build the standing TDD context, or nothing when no loop is active. */
export function buildTddContext(state: TddState) {
	const content = standingReminder(state.loop);
	if (!content) {
		return;
	}
	return {
		message: {
			customType: CONTEXT_TYPE,
			content,
			display: false,
		},
	};
}

/** A context handler that drops stale TDD context when no loop is active. */
export function tddContextFilter(state: TddState) {
	return filterContext(CONTEXT_TYPE, () => state.loop.phase !== "idle");
}
