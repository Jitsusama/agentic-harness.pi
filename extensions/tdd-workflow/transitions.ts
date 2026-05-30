/**
 * The persistent context the agent carries between turns: the
 * current phase, the behaviour under test and the standing
 * discipline for that phase, so the discipline survives a long
 * autonomous run. A companion filter strips this context once
 * the loop is no longer active, so a stale reminder never
 * lingers after the loop closes.
 */

import { filterContext } from "../../lib/internal/state.js";
import { disciplineFor } from "./discipline.js";
import type { LoopState } from "./machine.js";
import type { TddState } from "./state.js";

/** The customType tag for the injected TDD context message. */
const CONTEXT_TYPE = "tdd-workflow-context";

/** Whether a loop is live: engaged this session and past idle. */
function isActiveLoop(loop: LoopState): boolean {
	return loop.engaged && loop.phase !== "idle";
}

/** Build the standing TDD context, or nothing when no loop is active. */
export function buildTddContext(state: TddState) {
	const loop = state.loop;
	if (!isActiveLoop(loop)) {
		return;
	}
	const lines = [`TDD loop, ${loop.phase} phase.`];
	if (loop.behaviour) {
		lines.push(`Increment under test: ${loop.behaviour}.`);
	}
	lines.push(disciplineFor(loop.phase));
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
