/**
 * Pure stage machine for the focused document under a loaded
 * quest. Fully pi-agnostic; the implementation lives in
 * agentic-harness.core.
 */

export {
	type DocumentLoop,
	initialDocumentState,
	type Stage,
	type TransitionAction,
	type TransitionInput,
	type TransitionResult,
	transition,
} from "@jitsusama/agentic-harness.core/quest/machine";
