/**
 * TDD phase handlers: one function per action, dispatched
 * by the execute function in index.ts.
 *
 * Each handler follows the pattern: gate → advance → return.
 * The stayResult helper formats the response when the user
 * declines a transition.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { activate, advance, deactivate, nextCycle } from "./lifecycle.js";
import { PHASE_STAY, type Phase, type TddState } from "./state.js";
import { showTransitionGate } from "./transitions.js";

/** Parameters extracted from the tool call. */
interface PhaseParams {
	action: string;
	context: string | null;
	summary: string | null;
}

/** Standard tool result shape. */
interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
}

/** Build a tool result when the user declines a phase transition. */
function stayResult(phase: Phase, feedback?: string): ToolResult {
	const stay = PHASE_STAY[phase];
	const hint = feedback
		? `User feedback: ${feedback}\n\n${stay} Do not attempt to transition again unless the user asks.`
		: `Staying in ${phase.toUpperCase()}. ${stay} Do not attempt to transition again unless the user asks.`;
	return {
		content: [{ type: "text", text: hint }],
		details: { action: phase, stayed: true },
	};
}

/** Handle the "start" action: activate TDD mode. */
async function handleStart(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
): Promise<ToolResult> {
	if (state.enabled) {
		return { content: [{ type: "text", text: "TDD mode is already active." }] };
	}
	activate(state, pi, ctx, params.context);
	return {
		content: [{ type: "text", text: "TDD mode activated." }],
		details: { action: "start", context: params.context },
	};
}

/** Handle the "stop" action: deactivate TDD mode. */
async function handleStop(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
): Promise<ToolResult> {
	const gate = await showTransitionGate(state, ctx, {
		summary: params.summary ?? "Ending TDD session.",
		nextPhase: "stop",
	});
	if (!gate.approved) {
		return stayResult(state.phase, gate.feedback);
	}
	deactivate(state, pi, ctx);
	return {
		content: [{ type: "text", text: "TDD mode deactivated." }],
		details: { action: "stop", summary: params.summary },
	};
}

/** Handle the "red" action: enter the RED phase. */
async function handleRed(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
): Promise<ToolResult> {
	if (state.phase !== "red") {
		const gate = await showTransitionGate(state, ctx, {
			summary: params.summary ?? "Starting new test.",
			nextPhase: "red",
			nextContext: params.context,
		});
		if (!gate.approved) {
			return stayResult(state.phase, gate.feedback);
		}
	}
	if (params.context) state.testDescription = params.context;
	advance(state, "red", pi, ctx);
	return {
		content: [{ type: "text", text: "RED." }],
		details: {
			action: "red",
			context: params.context,
			summary: params.summary,
		},
	};
}

/** Handle the "green" action: enter the GREEN phase. */
async function handleGreen(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
): Promise<ToolResult> {
	const gate = await showTransitionGate(state, ctx, {
		summary: params.summary ?? "Test fails for the right reason.",
		nextPhase: "green",
		nextContext: params.context,
	});
	if (!gate.approved) {
		return stayResult(state.phase, gate.feedback);
	}
	if (params.context) state.testDescription = params.context;
	advance(state, "green", pi, ctx);
	return {
		content: [{ type: "text", text: "GREEN." }],
		details: {
			action: "green",
			context: params.context,
			summary: params.summary,
		},
	};
}

/** Handle the "refactor" action: enter the REFACTOR phase. */
async function handleRefactor(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
): Promise<ToolResult> {
	const gate = await showTransitionGate(state, ctx, {
		summary: params.summary ?? "Tests pass with minimum implementation.",
		nextPhase: "refactor",
	});
	if (!gate.approved) {
		return stayResult(state.phase, gate.feedback);
	}
	advance(state, "refactor", pi, ctx);
	return {
		content: [{ type: "text", text: "REFACTOR." }],
		details: { action: "refactor", summary: params.summary },
	};
}

/** Handle the "done" action: complete refactoring and start a new cycle. */
async function handleDone(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
): Promise<ToolResult> {
	const gate = await showTransitionGate(state, ctx, {
		summary: params.summary ?? "Refactoring complete.",
		nextPhase: "red",
		nextContext: params.context,
	});
	if (!gate.approved) {
		return stayResult(state.phase, gate.feedback);
	}
	nextCycle(state, pi, ctx, params.context);
	return {
		content: [{ type: "text", text: "Done." }],
		details: {
			action: "done",
			context: params.context,
			summary: params.summary,
		},
	};
}

/** Handler function signature. */
type PhaseHandler = (
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
) => Promise<ToolResult>;

/** Dispatch map from action name to handler. */
const HANDLERS: Record<string, PhaseHandler> = {
	start: handleStart,
	stop: handleStop,
	red: handleRed,
	green: handleGreen,
	refactor: handleRefactor,
	done: handleDone,
};

/**
 * Dispatch a TDD phase action to the appropriate handler.
 * Returns an error result for unknown actions.
 */
export async function dispatchPhaseAction(
	state: TddState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: PhaseParams,
): Promise<ToolResult> {
	if (params.action !== "start" && !state.enabled) {
		return {
			content: [
				{
					type: "text",
					text: "TDD mode is not active. Call with action 'start' first.",
				},
			],
		};
	}

	const handler = HANDLERS[params.action];
	if (!handler) {
		return {
			content: [{ type: "text", text: `Unknown action: ${params.action}` }],
		};
	}

	return handler(state, pi, ctx, params);
}
