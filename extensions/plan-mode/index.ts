/**
 * Plan Mode Extension
 *
 * Read-only investigation mode for collaborative planning.
 * When active, tools are restricted via setActiveTools() and
 * writes are only allowed to the plan directory.
 *
 * The planning skill teaches the methodology. This extension
 * enforces the guardrails.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { showGate } from "../lib/gate.js";
import { filterContext, getLastEntry } from "../lib/state.js";

const DEFAULT_PLAN_DIR = ".pi/plans";
const PLAN_TOOLS = ["read", "write", "bash", "grep", "find", "ls", "ask"];

// Git-mutating bash commands — blocked in plan mode.
// Context injection handles intent; this catches accidents.
const GIT_MUTATING =
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)\b/i;

export default function planMode(pi: ExtensionAPI) {
	let enabled = false;
	let planDir = DEFAULT_PLAN_DIR;
	let wroteToPlanDir = false;
	let savedTools: string[] | null = null;

	// ---- Helpers ----

	function loadPlanDir(cwd: string): string {
		try {
			const settingsPath = path.join(cwd, ".pi", "settings.json");
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			return settings.planDir ?? DEFAULT_PLAN_DIR;
		} catch {
			return DEFAULT_PLAN_DIR;
		}
	}

	function isInPlanDir(filePath: string, cwd: string): boolean {
		const resolved = path.resolve(cwd, filePath);
		const resolvedPlanDir = path.resolve(cwd, planDir);
		return (
			resolved.startsWith(resolvedPlanDir + path.sep) ||
			resolved === resolvedPlanDir
		);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"plan-mode",
			enabled ? ctx.ui.theme.fg("warning", "⏸ planning") : undefined,
		);
	}

	function activate(ctx: ExtensionContext): void {
		planDir = loadPlanDir(ctx.cwd);
		savedTools = pi.getActiveTools();
		enabled = true;
		pi.setActiveTools(PLAN_TOOLS);
		updateStatus(ctx);
		pi.appendEntry("plan-mode", { enabled, planDir });
	}

	function deactivate(ctx: ExtensionContext): void {
		enabled = false;
		pi.setActiveTools(savedTools ?? pi.getActiveTools());
		savedTools = null;
		updateStatus(ctx);
		pi.appendEntry("plan-mode", { enabled, planDir });
	}

	function toggle(ctx: ExtensionContext): void {
		if (enabled) {
			deactivate(ctx);
			ctx.ui.notify("Plan mode off.");
		} else {
			activate(ctx);
			ctx.ui.notify(`Plan mode on. Writes → ${planDir}`);
		}
	}

	// ---- Flag ----

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only investigation)",
		type: "boolean",
		default: false,
	});

	// ---- Commands ----

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only investigation)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerCommand("plan-dir", {
		description: "Show or set the plan directory for this session",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(`Plan directory: ${planDir}`, "info");
				return;
			}
			planDir = args.trim();
			pi.appendEntry("plan-mode", { enabled, planDir });
			ctx.ui.notify(`Plan directory: ${planDir}`, "info");
		},
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => toggle(ctx),
	});

	// ---- Tool call interception ----

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;

		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = String(
				(event.input as Record<string, unknown>).path ?? "",
			);
			if (isInPlanDir(filePath, ctx.cwd)) {
				wroteToPlanDir = true;
				return;
			}
			return {
				block: true,
				reason: `Plan mode: writes restricted to ${planDir}/. Exit with /plan first.`,
			};
		}

		if (isToolCallEventType("bash", event)) {
			if (GIT_MUTATING.test(event.input.command)) {
				return {
					block: true,
					reason:
						"Plan mode: git-mutating command blocked. Exit with /plan first.",
				};
			}
		}
	});

	// ---- Context injection ----

	pi.on("before_agent_start", async () => {
		if (!enabled) return;
		return {
			message: {
				customType: "plan-mode-context",
				content: [
					"[PLAN MODE — read-only investigation]",
					"",
					"Investigate the codebase, ask clarifying questions, and",
					"collaborate toward an implementation plan. Do not modify",
					"code files.",
					"",
					`Write plan files to: ${planDir}/`,
					"",
					"When the plan is ready and the user is satisfied, offer",
					"to transition to implementation (TDD or free-form).",
				].join("\n"),
				display: false,
			},
		};
	});

	// ---- Transition after plan is written ----

	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled || !ctx.hasUI || !wroteToPlanDir) return;
		wroteToPlanDir = false;

		const result = await showGate(ctx, {
			content: (theme) => [theme.fg("text", ` Plan written → ${planDir}`)],
			options: [
				{ label: "Implement with TDD", value: "tdd" },
				{ label: "Implement free-form", value: "freeform" },
				{ label: "Stay in planning", value: "stay" },
			],
			steerContext: "",
		});

		if (!result || result.value === "stay") return;

		deactivate(ctx);

		if (result.value === "steer") {
			pi.sendUserMessage(result.feedback ?? "", { deliverAs: "followUp" });
			return;
		}

		const msg =
			result.value === "tdd"
				? "Let's implement this plan with TDD. Start with step 1."
				: "Let's implement this plan. Start with step 1.";
		pi.sendUserMessage(msg, { deliverAs: "followUp" });
	});

	// ---- Filter stale context when not active ----

	pi.on(
		"context",
		filterContext("plan-mode-context", () => enabled),
	);

	// ---- Restore state on session start ----

	pi.on("session_start", async (_event, ctx) => {
		const saved = getLastEntry<{ enabled: boolean; planDir?: string }>(
			ctx,
			"plan-mode",
		);
		if (saved) {
			enabled = saved.enabled ?? false;
			planDir = saved.planDir ?? loadPlanDir(ctx.cwd);
		} else {
			planDir = loadPlanDir(ctx.cwd);
		}

		if (pi.getFlag("plan") === true) {
			enabled = true;
		}

		if (enabled) {
			pi.setActiveTools(PLAN_TOOLS);
		}

		updateStatus(ctx);
	});
}
