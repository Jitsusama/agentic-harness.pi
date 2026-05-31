/**
 * Context injection and filtering. While a plan is active, a
 * small factual note rides the system prompt so the agent always
 * knows the stage, the plan and where the document lives. It
 * carries facts only, not discipline: the stage discipline is
 * delivered once, on the transition that enters the stage, so it
 * never turns into a per-turn nag. When the plan goes idle or
 * terminal, the stale note is filtered out.
 */

import { filterContext } from "../../lib/internal/state.js";
import type { PlanState } from "./state.js";

/** The custom type tagging plan-workflow context messages. */
const CONTEXT_TYPE = "plan-workflow-context";

/** Stages where the plan is actively being worked. */
function isActive(state: PlanState): boolean {
	return (
		state.stage === "think" || state.stage === "plan" || state.stage === "build"
	);
}

/** Build the standing context note, or nothing when no plan is active. */
export function buildPlanContext(state: PlanState) {
	if (!isActive(state)) return;

	const lines = [`[PLAN WORKFLOW: ${state.stage}]`];
	if (state.planId) {
		lines.push(
			`Plan ${state.planId} "${state.title ?? "untitled"}" — ${state.done}/${state.total} checked.`,
		);
	}
	if (state.planPath) {
		lines.push(`Source of truth: ${state.planPath}`);
	}

	return {
		message: {
			customType: CONTEXT_TYPE,
			content: lines.join("\n"),
			display: false,
		},
	};
}

/** Strip stale plan context once the plan is no longer active. */
export function planContextFilter(state: PlanState) {
	return filterContext(CONTEXT_TYPE, () => isActive(state));
}
