/**
 * Plan mode transitions — agent_end gate, context injection,
 * and stale context filtering.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { filterContext } from "../lib/state.js";
import { showGate } from "../lib/ui/gate.js";
import { deactivate } from "./lifecycle.js";
import type { PlanState } from "./state.js";

/**
 * After the agent writes to the plan directory, offer
 * transition options: implement with TDD, free-form, or stay.
 */
export async function handlePlanWritten(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	if (!state.enabled || !ctx.hasUI || !state.wroteToPlanDir) return;
	state.wroteToPlanDir = false;

	const result = await showGate(ctx, {
		content: (theme) => [theme.fg("text", ` Plan written → ${state.planDir}`)],
		options: [
			{ label: "Implement with TDD", value: "tdd" },
			{ label: "Implement free-form", value: "freeform" },
			{ label: "Stay in planning", value: "stay" },
		],
		steerContext: "",
	});

	if (!result || result.value === "stay") return;

	deactivate(state, pi, ctx);

	if (result.value === "steer") {
		pi.sendUserMessage(result.feedback ?? "", { deliverAs: "followUp" });
		return;
	}

	const msg =
		result.value === "tdd"
			? "Let's implement this plan with TDD. Start with step 1."
			: "Let's implement this plan. Start with step 1.";
	pi.sendUserMessage(msg, { deliverAs: "followUp" });
}

/**
 * Inject planning context into the agent's system prompt.
 */
export function buildPlanContext(state: PlanState) {
	if (!state.enabled) return;

	return {
		message: {
			customType: "plan-mode-context",
			content: [
				"[PLAN MODE — read-only investigation]",
				"",
				"Investigate the codebase, ask clarifying questions, and",
				"collaborate toward an implementation plan. Do not modify",
				"code files.",
				"",
				`Write plan files to: ${state.planDir}/`,
				"",
				"When the plan is ready and the user is satisfied, offer",
				"to transition to implementation (TDD or free-form).",
			].join("\n"),
			display: false,
		},
	};
}

/**
 * Create a context filter that removes stale plan-mode context
 * when plan mode is not active.
 */
export function planContextFilter(state: PlanState) {
	return filterContext("plan-mode-context", () => state.enabled);
}
