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
 * transition options: implement or stay in planning.
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
			{ label: "Implement", value: "implement" },
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

	pi.sendUserMessage("Let's implement this plan. Start with step 1.", {
		deliverAs: "followUp",
	});
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
				"to transition to implementation.",
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
