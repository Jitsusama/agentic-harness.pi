/**
 * Handles plan mode transitions: the confirmation gate shown
 * when the agent finishes a turn, context injection into the
 * system prompt, and filtering out stale context.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { filterContext } from "../lib/state.js";
import { prompt } from "../lib/ui/panel.js";
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

	const result = await prompt(ctx, {
		content: (theme) => [theme.fg("text", ` Plan written → ${state.planDir}`)],
		actions: [
			{ key: "i", label: "Implement" },
			{ key: "s", label: "Stay in planning" },
		],
	});

	if (!result || (result.type === "action" && result.value === "s")) return;

	if (result.type === "redirect") {
		deactivate(state, pi, ctx);
		pi.sendUserMessage(result.note, { deliverAs: "followUp" });
		return;
	}

	if (result.type === "action" && result.value === "i") {
		deactivate(state, pi, ctx);

		if (result.note) {
			pi.sendUserMessage(result.note, { deliverAs: "followUp" });
			return;
		}

		pi.sendUserMessage("Let's implement this plan. Start with step 1.", {
			deliverAs: "followUp",
		});
	}
}

/**
 * Inject planning context into the agent's system prompt.
 */
export function buildPlanContext(state: PlanState) {
	if (!state.enabled) return;

	return {
		message: {
			customType: "plan-workflow-context",
			content: [
				"[PLAN MODE: read-only investigation]",
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
	return filterContext("plan-workflow-context", () => state.enabled);
}
