/**
 * The pure stage machine at the heart of the plan workflow. It
 * tracks one thing, the stage, and validates moves between
 * stages against attested justifications the agent supplies. It
 * imports nothing from pi and reads nothing about the world, so
 * it is fully unit-testable and can never rot against a language
 * or a tool. Discipline, rendering and persistence are layered
 * on by callers; this module only answers "is this move legal,
 * and what is the new stage."
 *
 * The stages are descriptive, not gates. think and plan are the
 * read-only postures (dig, debate, then draft the document);
 * build is where implementation happens; concluded and retired
 * are terminal. Returning to think from plan or build is how a
 * plan is reopened when discovery invalidates it.
 */

/** Where a plan effort currently sits. idle means none is active. */
export type Stage =
	| "idle"
	| "think"
	| "plan"
	| "build"
	| "concluded"
	| "retired";

/** The whole of the machine's state: just the current stage. */
export interface PlanLoop {
	stage: Stage;
}

/** The stages where a plan is actively being worked. */
const ACTIVE: Stage[] = ["think", "plan", "build"];

/** A fresh machine, resting at idle. */
export function initialState(): PlanLoop {
	return { stage: "idle" };
}

/** The moves an agent can attest between stages. */
export type TransitionAction =
	| "think"
	| "draft"
	| "build"
	| "conclude"
	| "retire";

/** The attested payload for a transition. Fields are per-action. */
export interface TransitionInput {
	action: TransitionAction;
	/** think: what the plan is about, or what sent us back to thinking. */
	note?: string;
	/** retire: why the plan is being abandoned. */
	reason?: string;
}

/** A legal move returns the new state; an illegal one returns guidance. */
export type TransitionResult =
	| { ok: true; state: PlanLoop }
	| { ok: false; guidance: string };

/** Whether a plan is actively being worked (not idle or terminal). */
function isActive(stage: Stage): boolean {
	return ACTIVE.includes(stage);
}

function advance(stage: Stage): TransitionResult {
	return { ok: true, state: { stage } };
}

function refuse(guidance: string): TransitionResult {
	return { ok: false, guidance };
}

/**
 * Validate and apply a stage transition. Pure: it never mutates
 * the input and never touches anything outside its arguments.
 */
export function transition(
	state: PlanLoop,
	input: TransitionInput,
): TransitionResult {
	switch (input.action) {
		case "think":
			return think(state, input);
		case "draft":
			return draft(state);
		case "build":
			return build(state);
		case "conclude":
			return conclude(state);
		case "retire":
			return retire(state, input);
		default:
			return refuse(
				`Unknown action. Use think, draft, build, conclude or retire.`,
			);
	}
}

function think(state: PlanLoop, input: TransitionInput): TransitionResult {
	if (!input.note?.trim()) {
		return refuse(
			"Say what this is about in a note: the problem you're planning, or what sent you back to thinking.",
		);
	}
	if (state.stage === "think") {
		return refuse("Already thinking. Draft the plan when you're ready.");
	}
	if (
		state.stage === "idle" ||
		state.stage === "plan" ||
		state.stage === "build"
	) {
		return advance("think");
	}
	return refuse("This plan is concluded. Start a fresh one.");
}

function draft(state: PlanLoop): TransitionResult {
	if (state.stage !== "think") {
		return refuse(
			"Draft from think: dig and debate first, then move to drafting the document.",
		);
	}
	return advance("plan");
}

function build(state: PlanLoop): TransitionResult {
	if (state.stage !== "plan") {
		return refuse(
			"Build from plan: draft the plan document first, then implement against it.",
		);
	}
	return advance("build");
}

function conclude(state: PlanLoop): TransitionResult {
	if (!isActive(state.stage)) {
		return refuse("No active plan to conclude.");
	}
	return advance("concluded");
}

function retire(state: PlanLoop, input: TransitionInput): TransitionResult {
	if (!isActive(state.stage)) {
		return refuse("No active plan to retire.");
	}
	if (!input.reason?.trim()) {
		return refuse("Give a reason for retiring the plan.");
	}
	return advance("retired");
}
