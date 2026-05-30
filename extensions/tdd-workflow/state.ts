/**
 * The session-level holder for the current TDD loop. The loop
 * is an immutable value the machine produces; this holder is the
 * single mutable cell the extension reassigns as the agent
 * drives transitions, and the thing lifecycle persists and
 * restores across a reload.
 */

import { initialState, type LoopState } from "./machine.js";

export type { LoopState } from "./machine.js";

/** The mutable session state: which loop is currently in play. */
export interface TddState {
	loop: LoopState;
}

/** Create the initial session state, with no loop in play. */
export function createTddState(): TddState {
	return { loop: initialState() };
}
