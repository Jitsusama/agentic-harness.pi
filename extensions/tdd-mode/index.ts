/**
 * TDD Mode Extension
 *
 * Red-green-refactor state machine with phase enforcement.
 * The TDD workflow skill teaches the methodology. This extension
 * enforces the discipline and adds the refactor gate + commit
 * proposal.
 *
 * Phases:
 *   RED → GREEN → REFACTOR → (commit) → RED
 */

import {
	type ExtensionAPI,
	isBashToolResult,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { enforceRedPhase } from "./enforce.js";
import { restore, toggle } from "./lifecycle.js";
import { createTddState } from "./state.js";
import {
	buildTddContext,
	handleRefactorGate,
	handleTestResult,
	tddContextFilter,
} from "./transitions.js";

export default function tddMode(pi: ExtensionAPI) {
	const state = createTddState();

	// ---- Commands ----

	pi.registerCommand("tdd", {
		description: "Toggle TDD mode, optionally with a plan file",
		handler: async (args, ctx) =>
			toggle(state, pi, ctx, args?.trim() || undefined),
	});

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Toggle TDD mode",
		handler: async (ctx) => toggle(state, pi, ctx),
	});

	// ---- Enforcement ----

	pi.on("tool_call", async (event, ctx) => {
		return enforceRedPhase(
			state,
			event.toolName,
			event.input as Record<string, unknown>,
			ctx,
		);
	});

	// ---- Phase transitions ----

	pi.on("tool_result", async (event, ctx) => {
		if (!state.enabled) return;
		if (!isBashToolResult(event)) return;

		const command = String(event.input?.command ?? "");
		const failed =
			event.isError ||
			(event.content?.[0] &&
				"text" in event.content[0] &&
				/fail|error|FAILED/i.test(event.content[0].text));

		handleTestResult(state, command, !!failed, ctx);
	});

	// ---- Refactor gate ----

	pi.on("agent_end", async (_event, ctx) => {
		await handleRefactorGate(state, pi, ctx);
	});

	// ---- Context ----

	pi.on("before_agent_start", async () => {
		return buildTddContext(state);
	});

	pi.on("context", tddContextFilter(state));

	// ---- Restore ----

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});
}
