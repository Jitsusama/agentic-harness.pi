/**
 * TDD mode enforcement — LLM-facing phase restrictions.
 *
 * Returns block results with hints that go back to the LLM,
 * not UI gates for the user. The agent self-corrects or
 * adjusts phase via the tdd_phase tool.
 *
 * RED: no file blocking (stubs are expected)
 * GREEN: block test file writes
 * REFACTOR: no file blocking (test cleanup is expected)
 */

import { isTestFile } from "./patterns.js";
import { PHASE_HINTS, type TddState } from "./state.js";

/**
 * Check a write/edit tool call against the current TDD phase.
 * Returns a block result with an LLM-facing hint, or undefined
 * to allow.
 */
export function enforceTddPhase(
	state: TddState,
	toolName: string,
	input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
	if (!state.enabled) return;
	if (toolName !== "write" && toolName !== "edit") return;

	const filePath = String(input.path ?? "");

	if (state.phase === "green" && isTestFile(filePath)) {
		return {
			block: true,
			reason: [
				"Blocked: cannot modify test file in GREEN phase.",
				"",
				PHASE_HINTS.green,
				"",
				`File: ${filePath}`,
				"",
				"If the user has redirected you away from TDD, call",
				"tdd_phase with action 'stop' first.",
			].join("\n"),
		};
	}
}
