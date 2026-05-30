/**
 * The persistent context the agent carries between turns: just
 * where the loop is. It reports the iteration, the phase and the
 * behaviour under test, so the agent never loses the thread on a
 * long autonomous run. It deliberately does not re-issue the
 * phase discipline every turn; that reminder rides the transition
 * reply, at the moment the agent asks for it. A companion filter
 * strips this context once the loop is no longer active.
 */

import { filterContext } from "../../lib/internal/state.js";
import type { LoopState } from "./machine.js";
import type { TddState } from "./state.js";

/** The customType tag for the injected TDD context message. */
const CONTEXT_TYPE = "tdd-workflow-context";

/** Whether a loop is live: past idle, with a transition in play. */
function isActiveLoop(loop: LoopState): boolean {
	return loop.phase !== "idle";
}

/** Build the standing TDD context, or nothing when no loop is active. */
export function buildTddContext(state: TddState) {
	const loop = state.loop;
	if (!isActiveLoop(loop)) {
		return;
	}
	const lines = [`TDD loop ${loop.iteration}, ${loop.phase} phase.`];
	if (loop.behaviour) {
		lines.push(`Increment under test: ${loop.behaviour}.`);
	}
	return {
		message: {
			customType: CONTEXT_TYPE,
			content: lines.join("\n"),
			display: false,
		},
	};
}

/** A context handler that drops stale TDD context when no loop is active. */
export function tddContextFilter(state: TddState) {
	return filterContext(CONTEXT_TYPE, () => isActiveLoop(state.loop));
}
