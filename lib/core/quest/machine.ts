/**
 * Pure stage machine for the focused document under a
 * loaded quest. Generalised from the plan-workflow machine
 * to operate on any document kind (plan, research, brief,
 * report); the stage names are the same so we keep one
 * mental model across kinds.
 *
 * Stages:
 *
 * - `idle`: no document focused (the quest may still be
 *   loaded; this is just about the document machine).
 * - `think`: the read-only posture where the agent
 *   investigates before committing to a shape. Code writes
 *   are blocked when the focused document is a plan.
 * - `draft`: writing the document. Code writes are still
 *   blocked when the focused document is a plan.
 * - `build`: implementing against the document. Code writes
 *   are allowed.
 * - `concluded`: terminal, work landed.
 * - `retired`: terminal, work abandoned.
 *
 * Returning to `think` from `draft` or `build` reopens the
 * loop when discovery invalidates the document. Thinking
 * from a terminal stage is refused: a concluded or retired
 * document is not silently reopened; draft a fresh document
 * or reopen the quest instead.
 */

export type Stage =
	| "idle"
	| "think"
	| "draft"
	| "build"
	| "concluded"
	| "retired";

export interface DocumentLoop {
	stage: Stage;
}

/** Stages where a document is actively being worked. */
const ACTIVE_STAGES: Stage[] = ["think", "draft", "build"];

export function initialDocumentState(): DocumentLoop {
	return { stage: "idle" };
}

export type TransitionAction =
	| "think"
	| "draft"
	| "build"
	| "conclude"
	| "retire";

export interface TransitionInput {
	action: TransitionAction;
	/** think: what this document is about or what sent us back. */
	note?: string;
	/** retire: why the document is being abandoned. */
	reason?: string;
}

export type TransitionResult =
	| { ok: true; state: DocumentLoop }
	| { ok: false; guidance: string };

function isActive(stage: Stage): boolean {
	return ACTIVE_STAGES.includes(stage);
}

function advance(stage: Stage): TransitionResult {
	return { ok: true, state: { stage } };
}

function refuse(guidance: string): TransitionResult {
	return { ok: false, guidance };
}

export function transition(
	state: DocumentLoop,
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
				"Unknown action. Use think, draft, build, conclude or retire.",
			);
	}
}

function think(state: DocumentLoop, input: TransitionInput): TransitionResult {
	if (!input.note?.trim()) {
		return refuse(
			"Say what this is about in a note: the problem you are investigating, or what sent you back to thinking.",
		);
	}
	if (state.stage === "think") {
		return refuse("Already thinking. Draft when you are ready.");
	}
	if (state.stage === "concluded" || state.stage === "retired") {
		return refuse(
			"This document is terminal; thinking would silently reopen it. Draft a fresh document, or reopen the quest if the whole thing is resuming.",
		);
	}
	return advance("think");
}

function draft(state: DocumentLoop): TransitionResult {
	if (state.stage !== "think") {
		return refuse(
			"Draft from think: dig and debate first, then write the document.",
		);
	}
	return advance("draft");
}

function build(state: DocumentLoop): TransitionResult {
	if (state.stage !== "draft") {
		return refuse(
			"Build from draft: write the document first, then implement against it.",
		);
	}
	return advance("build");
}

function conclude(state: DocumentLoop): TransitionResult {
	if (!isActive(state.stage)) {
		return refuse("No active document to conclude.");
	}
	return advance("concluded");
}

function retire(state: DocumentLoop, input: TransitionInput): TransitionResult {
	if (!isActive(state.stage)) {
		return refuse("No active document to retire.");
	}
	if (!input.reason?.trim()) {
		return refuse("Give a reason for retiring the document.");
	}
	return advance("retired");
}
