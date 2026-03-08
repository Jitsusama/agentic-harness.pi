/**
 * TDD mode transitions — phase advancement from test results,
 * refactor gate, context injection, and stale context filtering.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { filterContext } from "../lib/state.js";
import { showGate } from "../lib/ui/gate.js";
import { advance, deactivate, nextCycle } from "./lifecycle.js";
import { looksLikeTestRun } from "./patterns.js";
import { PHASE_INSTRUCTIONS, PHASE_LABELS, type TddState } from "./state.js";

/**
 * Advance phase based on test results. Called from tool_result.
 */
export function handleTestResult(
	state: TddState,
	command: string,
	failed: boolean,
	ctx: ExtensionContext,
): void {
	if (!state.enabled) return;
	if (!looksLikeTestRun(command)) return;

	if (state.phase === "red" && failed) {
		advance(state, "green", ctx);
	} else if (state.phase === "green" && !failed) {
		advance(state, "refactor", ctx);
	}
}

/**
 * Show the refactor gate when agent finishes in REFACTOR phase.
 */
export async function handleRefactorGate(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	if (!state.enabled || !ctx.hasUI || state.phase !== "refactor") return;

	const result = await showGate(ctx, {
		content: (theme) => [theme.fg("text", " Tests pass.")],
		options: [
			{ label: "Refactor the test", value: "refactor-test" },
			{ label: "Refactor the implementation", value: "refactor-impl" },
			{ label: "Commit and continue", value: "commit-continue" },
			{ label: "Commit and stop TDD", value: "commit-stop" },
		],
		steerContext: "",
	});

	if (!result) return;

	if (result.value === "steer") {
		pi.sendUserMessage(result.feedback ?? "", { deliverAs: "followUp" });
		return;
	}

	if (result.value === "refactor-test") {
		pi.sendUserMessage("Refactor the test. Run tests after changes.", {
			deliverAs: "followUp",
		});
		return;
	}

	if (result.value === "refactor-impl") {
		pi.sendUserMessage(
			"Refactor the implementation. Run tests after changes.",
			{ deliverAs: "followUp" },
		);
		return;
	}

	if (result.value === "commit-stop") {
		deactivate(state, pi, ctx);
		pi.sendUserMessage("Commit this work with a well-crafted commit message.", {
			deliverAs: "followUp",
		});
		return;
	}

	// commit-continue
	nextCycle(state, pi, ctx);
	const step = state.totalSteps ? ` Move on to step ${state.cycle}.` : "";
	pi.sendUserMessage(
		`Commit this work with a well-crafted commit message.${step}`,
		{ deliverAs: "followUp" },
	);
}

/**
 * Build TDD context for the agent's system prompt.
 */
export function buildTddContext(state: TddState) {
	if (!state.enabled) return;

	const planNote = state.planFile
		? `\nPlan file: ${state.planFile} — refer to it for the current step.`
		: "";

	return {
		message: {
			customType: "tdd-mode-context",
			content: [
				`[TDD MODE — ${PHASE_LABELS[state.phase]}]`,
				"",
				PHASE_INSTRUCTIONS[state.phase],
				planNote,
			]
				.filter(Boolean)
				.join("\n"),
			display: false,
		},
	};
}

/**
 * Create a context filter that removes stale TDD context
 * when TDD mode is not active.
 */
export function tddContextFilter(state: TddState) {
	return filterContext("tdd-mode-context", () => state.enabled);
}
