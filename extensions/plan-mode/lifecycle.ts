/**
 * Plan mode lifecycle — activate, deactivate, toggle, persist,
 * and restore.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getLastEntry } from "../lib/state.js";
import { DEFAULT_PLAN_DIR, PLAN_TOOLS, type PlanState } from "./state.js";

export function loadPlanDir(cwd: string): string {
	try {
		const settingsPath = path.join(cwd, ".pi", "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return settings.planDir ?? DEFAULT_PLAN_DIR;
	} catch {
		return DEFAULT_PLAN_DIR;
	}
}

export function updateStatus(state: PlanState, ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		"plan-mode",
		state.enabled ? ctx.ui.theme.fg("warning", "⏸ planning") : undefined,
	);
}

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
	pi.appendEntry("plan-mode", {
		enabled: state.enabled,
		planDir: state.planDir,
	});
}

export function deactivate(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.enabled = false;
	pi.setActiveTools(state.savedTools ?? pi.getActiveTools());
	state.savedTools = null;
	updateStatus(state, ctx);
	pi.appendEntry("plan-mode", {
		enabled: state.enabled,
		planDir: state.planDir,
	});
}

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

export function restore(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const saved = getLastEntry<{ enabled: boolean; planDir?: string }>(
		ctx,
		"plan-mode",
	);
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
