/**
 * TDD mode lifecycle — activate, deactivate, toggle, phase
 * advancement, persist, and restore.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { getLastEntry } from "../lib/state.js";
import { PHASE_GLYPHS, type Phase, type TddState } from "./state.js";

function updateUI(state: TddState, ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setStatus("tdd-mode", undefined);
		ctx.ui.setWidget("tdd-test", undefined);
		return;
	}

	ctx.ui.setStatus("tdd-mode", "🧪 TDD");

	const glyph = PHASE_GLYPHS[state.phase];
	const desc = state.testDescription;
	const label = desc ? `${glyph} ${desc}` : glyph;

	ctx.ui.setWidget("tdd-test", (_tui, theme) => {
		return {
			render(width: number): string[] {
				const text = theme.fg("dim", label);
				const pad = Math.max(0, width - visibleWidth(label));
				return [`${" ".repeat(pad)}${text}`];
			},
		};
	});
}

export function persist(state: TddState, pi: ExtensionAPI): void {
	pi.appendEntry("tdd-mode", {
		enabled: state.enabled,
		phase: state.phase,
		cycle: state.cycle,
		planFile: state.planFile,
		testDescription: state.testDescription,
	});
}

export function activate(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	testDescription: string | null,
): void {
	state.enabled = true;
	state.phase = "red";
	state.cycle = 1;
	state.testDescription = testDescription;

	updateUI(state, ctx);
	persist(state, pi);
}

export function deactivate(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.enabled = false;
	state.testDescription = null;
	updateUI(state, ctx);
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
		if (plan) {
			state.planFile = plan;
		}
		activate(state, pi, ctx, null);
		ctx.ui.notify("TDD mode on.");
	}
}

export function advance(
	state: TddState,
	next: Phase,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.phase = next;
	updateUI(state, ctx);
	persist(state, pi);
}

export function nextCycle(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	testDescription: string | null,
): void {
	state.cycle++;
	state.phase = "red";
	state.testDescription = testDescription;
	updateUI(state, ctx);
	persist(state, pi);
}

export function restore(
	state: TddState,
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const saved = getLastEntry<TddState>(ctx, "tdd-mode");
	if (saved) {
		state.enabled = saved.enabled ?? false;
		state.phase = saved.phase ?? "red";
		state.cycle = saved.cycle ?? 1;
		state.planFile = saved.planFile ?? null;
		state.testDescription = saved.testDescription ?? null;
	}
	updateUI(state, ctx);
}
