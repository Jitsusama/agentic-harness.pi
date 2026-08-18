/**
 * The session-level holder for the current TDD loop. The loop
 * is an immutable value core/tdd's domain produces; this holder
 * is the single mutable cell the extension reassigns as the agent
 * drives transitions, and the thing lifecycle persists and
 * restores across a reload.
 */

import { idleLoop, type Loop } from "@jitsusama/agentic-harness.core/tdd";

export type { Loop } from "@jitsusama/agentic-harness.core/tdd";

/** The mutable session state: which loop is currently in play. */
export interface TddState {
	loop: Loop;
}

/** Create the initial session state, with no loop in play. */
export function createTddState(): TddState {
	return { loop: idleLoop() };
}
