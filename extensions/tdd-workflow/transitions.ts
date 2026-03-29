/**
 * Handles TDD mode transitions: confirmation gates shown
 * between phases, context injection into the system prompt,
 * and filtering out stale context messages. Phase advancement
 * is driven by the agent calling the tdd_phase tool.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { promptSingle, renderMarkdown } from "../../lib/ui/index.js";
import { filterContext } from "../lib/state.js";
import {
	PHASE_COLORS,
	PHASE_GLYPH,
	type PhaseColor,
	type TddPhase,
	type TddState,
} from "./state.js";

/** Max length for the short summary shown in the gate header. */
const SUMMARY_MAX_LENGTH = 50;
/** Minimum word-boundary position for truncation. */
const SUMMARY_MIN_TRUNCATE = 20;

/** Human-readable phase names for gate display. */
const PHASE_NAMES: Record<TddPhase, string> = {
	red: "Red",
	green: "Green",
	refactor: "Refactor",
};

/** Extract first sentence or clause as a short title. */
function shortSummary(text: string): string {
	const cut = text.search(/\.\s|—|\n/);
	if (cut > 0 && cut <= SUMMARY_MAX_LENGTH) return text.slice(0, cut);
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
 * Returns whether the user approved or wants to stay/redirect.
 */
export async function showTransitionGate(
	state: TddState,
	ctx: ExtensionContext,
	opts: {
		summary: string;
		nextPhase: TddPhase | "stop";
		nextContext?: string;
	},
): Promise<TransitionGateResult> {
	if (!ctx.hasUI) return { approved: true };

	const currentColor = PHASE_COLORS[state.phase];
	const currentName = PHASE_NAMES[state.phase];

	const isStop = opts.nextPhase === "stop";
	const nextColor: PhaseColor | "dim" = isStop
		? "dim"
		: PHASE_COLORS[opts.nextPhase];
	const nextName = isStop ? "Stop" : PHASE_NAMES[opts.nextPhase];

	const result = await promptSingle(ctx, {
		title: `${currentName} → ${nextName}`,
		content: (theme, width) => {
			const short = shortSummary(opts.summary);
			const lines = [
				truncateToWidth(
					` ${theme.fg(currentColor, PHASE_GLYPH)} → ${theme.fg(nextColor, PHASE_GLYPH)}  ${theme.fg("text", short)}`,
					width,
				),
				"",
			];
			for (const line of renderMarkdown(opts.summary, theme, width)) {
				lines.push(line);
			}
			if (opts.nextContext) {
				lines.push(
					"",
					truncateToWidth(theme.fg("dim", ` Next: ${opts.nextContext}`), width),
				);
			}
			return lines;
		},
	});

	if (!result) return { approved: false };

	if (result.type === "redirect") {
		return { approved: false, feedback: result.note };
	}

	// Enter (with or without note via Shift+Enter)
	if (result.note) return { approved: false, feedback: result.note };
	return { approved: true };
}

/**
 * Build TDD context for the agent's system prompt.
 */
export function buildTddContext(state: TddState) {
	if (!state.enabled) return;

	const parts = [`[TDD: ${state.phase.toUpperCase()}]`];

	if (state.testDescription) {
		parts.push(`Testing: ${state.testDescription}`);
	}

	if (state.planFile) {
		parts.push(`Plan: ${state.planFile}`);
	}

	return {
		message: {
			customType: "tdd-workflow-context",
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
	return filterContext("tdd-workflow-context", () => state.enabled);
}
