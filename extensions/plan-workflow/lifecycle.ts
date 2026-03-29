/**
 * Manages the full lifecycle of plan mode: turning it on and
 * off, toggling between states, and persisting settings across
 * sessions so nothing gets lost.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getLastEntry, loadPlanDir } from "../../lib/internal/state.js";
import { PLAN_TOOLS, type PlanState } from "./state.js";

/** Shape of plan-workflow data written to session history. */
interface PersistedState {
	enabled: boolean;
	planDir?: string;
}

/** Update the status line to reflect plan mode state. */
export function updateStatus(state: PlanState, ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		"plan-workflow",
		state.enabled
			? `${theme.fg("warning", "◈")} ${theme.fg("muted", "Plan")}`
			: undefined,
	);
}

/** Enter plan mode: restrict tools and persist state. */
export function activate(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.planDir = loadPlanDir(ctx.cwd);
	state.savedTools = pi.getActiveTools();
	state.enabled = true;
	pi.setActiveTools(PLAN_TOOLS);
	updateStatus(state, ctx);
	pi.appendEntry("plan-workflow", {
		enabled: state.enabled,
		planDir: state.planDir,
	});
}

/** Exit plan mode: restore tools and persist state. */
export function deactivate(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.enabled = false;
	pi.setActiveTools(state.savedTools ?? pi.getActiveTools());
	state.savedTools = null;
	updateStatus(state, ctx);
	pi.appendEntry("plan-workflow", {
		enabled: state.enabled,
		planDir: state.planDir,
	});
}

/** Toggle plan mode on or off with user notification. */
export function toggle(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (state.enabled) {
		deactivate(state, pi, ctx);
		ctx.ui.notify("Plan mode off.");
	} else {
		activate(state, pi, ctx);
		ctx.ui.notify(`Plan mode on. Writes → ${state.planDir}`);
	}
}

/** Restore plan mode state from the session history. */
export function restore(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const saved = getLastEntry<PersistedState>(ctx, "plan-workflow");
	if (saved) {
		state.enabled = saved.enabled ?? false;
		state.planDir = saved.planDir ?? loadPlanDir(ctx.cwd);
	} else {
		state.planDir = loadPlanDir(ctx.cwd);
	}

	if (pi.getFlag("plan") === true) {
		state.enabled = true;
	}

	if (state.enabled) {
		pi.setActiveTools(PLAN_TOOLS);
	}

	updateStatus(state, ctx);
}
