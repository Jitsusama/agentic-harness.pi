/**
 * Defines the runtime state shape for TDD mode, including
 * the phase definitions and sensible defaults.
 */

/** The three phases of the red-green-refactor cycle. */
export type Phase = "red" | "green" | "refactor";

/** Runtime state for TDD mode. */
export interface TddState {
	enabled: boolean;
	phase: Phase;
	cycle: number;
	planFile: string | null;
	testDescription: string | null;
}

/** Emoji glyphs for each phase, used in status display and gates. */
/** Glyph used for all phase indicators: coloured by the caller. */
export const PHASE_GLYPH = "●";

/** Theme color name for each phase. */
export type PhaseColor = "error" | "success" | "accent";

/** Theme color for each phase. */
export const PHASE_COLORS: Record<Phase, PhaseColor> = {
	red: "error",
	green: "success",
	refactor: "accent",
};

/** LLM-facing phase descriptions used in enforcement block messages. */
export const PHASE_HINTS: Record<Phase, string> = {
	red: [
		"You are in RED phase. Write a failing test that describes",
		"the desired behaviour. Minimal stubs in implementation files",
		"are fine to get a clean assertion failure. When the test",
		"fails for the right reason, signal the green phase.",
	].join(" "),
	green: [
		"You are in GREEN phase. Write the minimum implementation",
		"to make the failing test pass. Do not add or modify tests.",
		"When tests pass, signal the refactor phase.",
	].join(" "),
	refactor: [
		"You are in REFACTOR phase. Restructure existing code for",
		"clarity without changing behaviour. Do not add new tests or",
		"new functionality. Run tests after each change. When done,",
		"signal done to complete the cycle.",
	].join(" "),
};

/** What to do when the user chooses to stay in a phase. */
export const PHASE_STAY: Record<Phase, string> = {
	red: "Keep working on the test. The user wants more iteration before moving on.",
	green:
		"Keep working on the implementation. The user wants more work done before refactoring.",
	refactor:
		"Keep refactoring. The user wants more cleanup before completing the cycle.",
};

/** Create the initial TDD mode state. */
export function createTddState(): TddState {
	return {
		enabled: false,
		phase: "red",
		cycle: 1,
		planFile: null,
		testDescription: null,
	};
}
