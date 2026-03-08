/**
 * TDD mode state — shape, defaults, phase definitions.
 */

export type Phase = "red" | "green" | "refactor";

export interface TddState {
	enabled: boolean;
	phase: Phase;
	cycle: number;
	planFile: string | null;
	totalSteps: number | null;
}

export const PHASE_LABELS: Record<Phase, string> = {
	red: "🔴 RED",
	green: "🟢 GREEN",
	refactor: "🔄 REFACTOR",
};

export const PHASE_INSTRUCTIONS: Record<Phase, string> = {
	red: [
		"Write a test that describes the desired behavior.",
		"Only create or modify test files. Minimal stubs in",
		"implementation files are allowed if needed to get the",
		"test to fail for the right reason.",
		"When the test is written, run it to verify it fails.",
	].join(" "),
	green: [
		"Write the minimum code to make the test pass. No more.",
		"Don't anticipate future needs. When done, run the tests.",
	].join(" "),
	refactor: [
		"Tests pass. Present the current state to the user.",
		"Wait for the user to decide: refactor the test, refactor",
		"the implementation, or move on. Run tests after each",
		"refactor change.",
	].join(" "),
};

export function createTddState(): TddState {
	return {
		enabled: false,
		phase: "red",
		cycle: 1,
		planFile: null,
		totalSteps: null,
	};
}
