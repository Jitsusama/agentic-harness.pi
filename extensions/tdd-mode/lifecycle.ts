/**
 * TDD mode lifecycle — activate, deactivate, toggle, phase
 * advancement, persist, and restore.
 */

import * as fs from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getLastEntry } from "../lib/state.js";
import { PHASE_LABELS, type Phase, type TddState } from "./state.js";

function statusText(state: TddState, ctx: ExtensionContext): string {
	const label = PHASE_LABELS[state.phase];
	const step = state.totalSteps
		? `Step ${state.cycle}/${state.totalSteps}`
		: `Cycle ${state.cycle}`;
	return ctx.ui.theme.fg("accent", `${label} — ${step}`);
}

export function updateStatus(state: TddState, ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		"tdd-mode",
		state.enabled ? statusText(state, ctx) : undefined,
	);
}

export function persist(state: TddState, pi: ExtensionAPI): void {
	pi.appendEntry("tdd-mode", {
		enabled: state.enabled,
		phase: state.phase,
		cycle: state.cycle,
		planFile: state.planFile,
		totalSteps: state.totalSteps,
	});
}

export function activate(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	plan?: string,
): void {
	state.enabled = true;
	state.phase = "red";
	state.cycle = 1;
	state.planFile = plan ?? null;
	state.totalSteps = null;

	if (state.planFile) {
		try {
			const content = fs.readFileSync(state.planFile, "utf-8");
			const steps = content.match(/^\s*\d+\.\s+/gm);
			state.totalSteps = steps?.length ?? null;
		} catch {
			/* Plan file unreadable — step count stays null */
		}
	}

	updateStatus(state, ctx);
	persist(state, pi);
}

export function deactivate(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.enabled = false;
	updateStatus(state, ctx);
	persist(state, pi);
}

export function toggle(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	plan?: string,
): void {
	if (state.enabled) {
		deactivate(state, pi, ctx);
		ctx.ui.notify("TDD mode off.");
	} else {
		activate(state, pi, ctx, plan);
		ctx.ui.notify(
			state.planFile
				? `TDD mode on. Plan: ${state.planFile} (${state.totalSteps ?? "?"} steps)`
				: "TDD mode on.",
		);
	}
}

export function advance(
	state: TddState,
	next: Phase,
	ctx: ExtensionContext,
): void {
	state.phase = next;
	updateStatus(state, ctx);
}

export function nextCycle(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.cycle++;
	state.phase = "red";
	updateStatus(state, ctx);
	persist(state, pi);
}

export function restore(state: TddState, ctx: ExtensionContext): void {
	const saved = getLastEntry<TddState>(ctx, "tdd-mode");
	if (saved) {
		state.enabled = saved.enabled ?? false;
		state.phase = saved.phase ?? "red";
		state.cycle = saved.cycle ?? 1;
		state.planFile = saved.planFile ?? null;
		state.totalSteps = saved.totalSteps ?? null;
	}
	updateStatus(state, ctx);
}
