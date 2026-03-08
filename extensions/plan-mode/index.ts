/**
 * Plan Mode Extension
 *
 * Read-only investigation mode for collaborative planning.
 * When active, tools are restricted and writes are only allowed
 * to the plan directory.
 *
 * The planning skill teaches the methodology. This extension
 * enforces the guardrails.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { enforcePlanMode } from "./enforce.js";
import { restore, toggle } from "./lifecycle.js";
import { createPlanState } from "./state.js";
import {
	buildPlanContext,
	handlePlanWritten,
	planContextFilter,
} from "./transitions.js";

export default function planMode(pi: ExtensionAPI) {
	const state = createPlanState();

	// ---- Flag ----

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only investigation)",
		type: "boolean",
		default: false,
	});

	// ---- Commands ----

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only investigation)",
		handler: async (_args, ctx) => toggle(state, pi, ctx),
	});

	pi.registerCommand("plan-dir", {
		description: "Show or set the plan directory for this session",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(`Plan directory: ${state.planDir}`, "info");
				return;
			}
			state.planDir = args.trim();
			pi.appendEntry("plan-mode", {
				enabled: state.enabled,
				planDir: state.planDir,
			});
			ctx.ui.notify(`Plan directory: ${state.planDir}`, "info");
		},
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => toggle(state, pi, ctx),
	});

	// ---- Enforcement ----

	pi.on("tool_call", async (event, ctx) => {
		return enforcePlanMode(
			state,
			event.toolName,
			event.input as Record<string, unknown>,
			ctx.cwd,
		);
	});

	// ---- Transitions ----

	pi.on("agent_end", async (_event, ctx) => {
		await handlePlanWritten(state, pi, ctx);
	});

	pi.on("before_agent_start", async () => {
		return buildPlanContext(state);
	});

	pi.on("context", planContextFilter(state));

	// ---- Restore ----

	pi.on("session_start", async (_event, ctx) => {
		restore(state, pi, ctx);
	});
}
