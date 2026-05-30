/**
 * The TDD loop state machine: a pure reducer over a single,
 * discrete red-green-refactor loop.
 *
 * The agent drives the loop by attesting each transition. A
 * transition is allowed only when the agent supplies the
 * justification the gate requires; otherwise the reducer
 * refuses and hands back guidance. The machine never inspects
 * code, test output or file paths. It tracks the agent's own
 * attestation, which is the one contract that stays robust
 * across every language.
 */

/** Where a loop sits in the red-green-refactor cycle. */
export type Phase = "idle" | "plan" | "write" | "red" | "green" | "refactor";

/** Whether a reported failure is a real assertion or noise. */
export type FailureKind = "assertion" | "other";

/** The live state of one discrete TDD loop. */
export interface LoopState {
	phase: Phase;
	assertionFailure: boolean;
	behaviour: string | null;
	iteration: number;
}

/** The resting state: no loop in play. */
export function initialState(): LoopState {
	return {
		phase: "idle",
		assertionFailure: false,
		behaviour: null,
		iteration: 0,
	};
}

/** Close the active loop back to idle, keeping the iteration count. */
function rest(state: LoopState): LoopState {
	return {
		phase: "idle",
		assertionFailure: false,
		behaviour: null,
		iteration: state.iteration,
	};
}

/** The transitions the agent can attest. */
export type TransitionAction =
	| "plan"
	| "write"
	| "red"
	| "green"
	| "refactor"
	| "done"
	| "abandon";

/** A transition request, carrying whatever justification it offers. */
export interface TransitionInput {
	action: TransitionAction;
	behaviour?: string;
	interface?: string;
	failure?: string;
	failureKind?: FailureKind;
	pass?: string;
	reflection?: string;
	reason?: string;
}

/** The outcome of attempting a transition: advance, or refuse with guidance. */
export type TransitionResult =
	| { ok: true; state: LoopState }
	| { ok: false; guidance: string };

/** Refuse a transition, handing the agent guidance on what's missing. */
function refuse(guidance: string): TransitionResult {
	return { ok: false, guidance };
}

/** Accept a transition into a new state. */
function advance(state: LoopState): TransitionResult {
	return { ok: true, state };
}

/** Attempt a transition, enforcing the justification each gate requires. */
export function transition(
	state: LoopState,
	input: TransitionInput,
): TransitionResult {
	switch (input.action) {
		case "plan":
			return plan(state, input);
		case "write":
			return write(state, input);
		case "red":
			return red(state, input);
		case "green":
			return green(state, input);
		case "refactor":
			return refactor(state);
		case "done":
			return done(state, input);
		case "abandon":
			return abandon(state, input);
		default:
			return refuse(
				`Unknown transition. Drive the loop with plan, write, red, ` +
					`green, refactor, done or abandon.`,
			);
	}
}

function plan(state: LoopState, input: TransitionInput): TransitionResult {
	if (state.phase !== "idle") {
		return refuse(
			`Finish or abandon the current loop before planning another. You're in ${state.phase}.`,
		);
	}
	if (!input.behaviour) {
		return refuse(
			"Name the single behaviour under test: the exported thing you " +
				"want to exist. One increment per loop.",
		);
	}
	return advance({
		phase: "plan",
		assertionFailure: false,
		behaviour: input.behaviour,
		iteration: state.iteration + 1,
	});
}

function write(state: LoopState, input: TransitionInput): TransitionResult {
	if (state.phase !== "plan") {
		return refuse(
			`Writing the test follows plan. You're in ${state.phase}, not plan. ` +
				`Go forward, or abandon to redo.`,
		);
	}
	if (!input.interface) {
		return refuse(
			"State the exported surface this test binds to before writing it. " +
				"Tests document the interface, never the internals.",
		);
	}
	return advance({ ...state, phase: "write" });
}

function red(state: LoopState, input: TransitionInput): TransitionResult {
	if (state.phase !== "write" && state.phase !== "red") {
		return refuse(
			`A failing test comes out of the write phase. You're in ${state.phase}.`,
		);
	}
	if (!input.failure) {
		return refuse("Run the test and report the failure before moving to red.");
	}
	if (!input.failureKind) {
		return refuse(
			"Say whether the failure was an assertion or other (a compile or " +
				"missing-symbol error). Only a real assertion clears the way to green.",
		);
	}
	return advance({
		...state,
		phase: "red",
		assertionFailure: input.failureKind === "assertion",
	});
}

function green(state: LoopState, input: TransitionInput): TransitionResult {
	if (state.phase !== "red" || !state.assertionFailure) {
		return refuse(
			"You haven't seen a real red yet. Stub a minimal skeleton, re-run, " +
				"and call red again with failureKind 'assertion' before green.",
		);
	}
	if (!input.pass) {
		return refuse("Report the passing result before moving to green.");
	}
	return advance({ ...state, phase: "green", assertionFailure: false });
}

function refactor(state: LoopState): TransitionResult {
	if (state.phase !== "green") {
		return refuse(
			`Refactoring follows a green test. You're in ${state.phase}.`,
		);
	}
	return advance({ ...state, phase: "refactor" });
}

function done(state: LoopState, input: TransitionInput): TransitionResult {
	if (state.phase !== "refactor") {
		return refuse(
			`Close the loop from the refactor phase, not ${state.phase}. ` +
				`Pass through refactor first, even as a no-op.`,
		);
	}
	if (!input.reflection) {
		return refuse(
			"Before you close, say what you reconsidered about the internal and " +
				"external design now that a real consumer exists.",
		);
	}
	return advance(rest(state));
}

function abandon(state: LoopState, input: TransitionInput): TransitionResult {
	if (state.phase === "idle") {
		return refuse("There's no loop to abandon. Plan one when you're ready.");
	}
	if (!input.reason) {
		return refuse("Give a reason for leaving the loop before you abandon it.");
	}
	return advance(rest(state));
}
