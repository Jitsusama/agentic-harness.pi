/**
 * TDD mode transitions — confirmation gates, context injection,
 * and stale context filtering. Phase advancement is driven by
 * the agent calling the tdd_phase tool.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { filterContext } from "../lib/state.js";
import { showGate } from "../lib/ui/gate.js";
import { PHASE_GLYPHS, type Phase, type TddState } from "./state.js";

/** Max length for the short summary shown in the gate header. */
const SUMMARY_MAX_LENGTH = 50;
/** Minimum word-boundary position for truncation. */
const SUMMARY_MIN_TRUNCATE = 20;

/** Human-readable phase names for gate display. */
const PHASE_NAMES: Record<Phase, string> = {
	red: "RED",
	green: "GREEN",
	refactor: "REFACTOR",
};

/** Extract first sentence or clause as a short title. */
function shortSummary(text: string): string {
	// Split on sentence end or em-dash
	const cut = text.search(/\.\s|—|\n/);
	if (cut > 0 && cut <= SUMMARY_MAX_LENGTH) return text.slice(0, cut);
	// Truncate at word boundary
	if (text.length <= SUMMARY_MAX_LENGTH) return text;
	const truncated = text.slice(0, SUMMARY_MAX_LENGTH);
	const lastSpace = truncated.lastIndexOf(" ");
	return `${lastSpace > SUMMARY_MIN_TRUNCATE ? truncated.slice(0, lastSpace) : truncated}…`;
}

/** Result of a TDD phase transition confirmation gate. */
export interface TransitionGateResult {
	/** Whether the user approved the transition. */
	approved: boolean;
	/** Steer feedback if the user chose to redirect. */
	feedback?: string;
}

/**
 * Show a confirmation gate before a TDD phase transition.
 * Returns whether the user approved or wants to stay/steer.
 */
export async function showTransitionGate(
	state: TddState,
	ctx: ExtensionContext,
	opts: {
		summary: string;
		nextPhase: Phase | "stop";
		nextContext?: string;
	},
): Promise<TransitionGateResult> {
	if (!ctx.hasUI) return { approved: true };

	const currentGlyph = PHASE_GLYPHS[state.phase];
	const currentName = PHASE_NAMES[state.phase];

	const isStop = opts.nextPhase === "stop";
	const nextGlyph = isStop ? "⏹" : PHASE_GLYPHS[opts.nextPhase];
	const nextName = isStop ? "STOP" : PHASE_NAMES[opts.nextPhase];

	const result = await showGate(ctx, {
		content: (theme) => {
			const short = shortSummary(opts.summary);
			const lines = [
				theme.fg("text", ` ${currentGlyph} → ${nextGlyph}  ${short}`),
				"",
				theme.fg("muted", ` ${opts.summary}`),
			];
			if (opts.nextContext) {
				lines.push("", theme.fg("dim", ` Next: ${opts.nextContext}`));
			}
			return lines;
		},
		options: [
			{ label: `${nextName}`, value: "transition" },
			{ label: `Stay in ${currentName}`, value: "stay" },
		],
		steerContext: opts.summary,
	});

	if (!result || result.value === "stay") {
		return { approved: false };
	}

	if (result.value === "steer") {
		return { approved: false, feedback: result.feedback };
	}

	return { approved: true };
}

/**
 * Build TDD context for the agent's system prompt.
 */
export function buildTddContext(state: TddState) {
	if (!state.enabled) return;

	const parts = [`[TDD — ${state.phase.toUpperCase()}]`];

	if (state.testDescription) {
		parts.push(`Testing: ${state.testDescription}`);
	}

	if (state.planFile) {
		parts.push(`Plan: ${state.planFile}`);
	}

	return {
		message: {
			customType: "tdd-mode-context",
			content: parts.join(" | "),
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
