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

import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// Dynamic import — static imports from sibling dirs crash
// extension loading under pi's jiti module resolution.
let _gate: typeof import("../shared/gate.js") | null = null;
async function getGate() {
	if (!_gate) _gate = await import("../shared/gate.js");
	return _gate;
}

const DEFAULT_PLAN_DIR = ".pi/plans";

// Tool sets
const PLAN_TOOLS = ["read", "write", "bash", "grep", "find", "ls", "ask"];
const NORMAL_TOOLS = ["read", "bash", "edit", "write"];

// Git-mutating bash commands — blocked in plan mode.
// Context injection handles intent; this catches accidents.
const GIT_MUTATING = /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)\b/i;

export default function planMode(pi: ExtensionAPI) {
	let enabled = false;
	let planDir = DEFAULT_PLAN_DIR;
	let wroteToPlanDir = false;

	// ---- Helpers ----

	function loadPlanDir(cwd: string): string {
		try {
			const settingsPath = path.join(cwd, ".pi", "settings.json");
			const settings = JSON.parse(
				fs.readFileSync(settingsPath, "utf-8"),
			);
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
			enabled
				? ctx.ui.theme.fg("warning", "⏸ planning")
				: undefined,
		);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", { enabled, planDir });
	}

	function activate(ctx: ExtensionContext): void {
		enabled = true;
		pi.setActiveTools(PLAN_TOOLS);
		updateStatus(ctx);
		persistState();
	}

	function deactivate(ctx: ExtensionContext): void {
		enabled = false;
		pi.setActiveTools(NORMAL_TOOLS);
		updateStatus(ctx);
		persistState();
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
		handler: async (_args, ctx) => {
			if (enabled) {
				deactivate(ctx);
				ctx.ui.notify("Plan mode off. Full access restored.");
			} else {
				planDir = loadPlanDir(ctx.cwd);
				activate(ctx);
				ctx.ui.notify(
					`Plan mode on. Writes restricted to: ${planDir}`,
				);
			}
		},
	});

	pi.registerCommand("plan-dir", {
		description: "Show or set the plan directory for this session",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(`Plan directory: ${planDir}`, "info");
				return;
			}
			planDir = args.trim();
			persistState();
			ctx.ui.notify(`Plan directory: ${planDir}`, "info");
		},
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (enabled) {
				deactivate(ctx);
				ctx.ui.notify("Plan mode off. Full access restored.");
			} else {
				planDir = loadPlanDir(ctx.cwd);
				activate(ctx);
				ctx.ui.notify(
					`Plan mode on. Writes restricted to: ${planDir}`,
				);
			}
		},
	});

	// ---- Tool call interception ----

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;

		// write/edit: allow only to plan directory
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = String(
				(event.input as Record<string, unknown>).path ?? "",
			);
			if (isInPlanDir(filePath, ctx.cwd)) {
				wroteToPlanDir = true;
				return; // Allow
			}
			return {
				block: true,
				reason: `Plan mode: writes restricted to ${planDir}/. Exit plan mode with /plan first.`,
			};
		}

		// bash: block git-mutating commands
		if (isToolCallEventType("bash", event)) {
			if (GIT_MUTATING.test(event.input.command)) {
				return {
					block: true,
					reason: "Plan mode: git-mutating command blocked. Exit plan mode with /plan first.",
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

		const { showGate } = await getGate();
		const result = await showGate(ctx, {
			content: (theme, _width) => [
				theme.fg("text", ` Plan written → ${planDir}`),
			],
			options: [
				{ label: "Implement with TDD", value: "tdd" },
				{ label: "Implement free-form", value: "freeform" },
				{ label: "Stay in planning", value: "stay" },
			],
			steerContext: "",
		});

		if (!result || result.value === "stay") return;

		if (result.value === "steer") {
			deactivate(ctx);
			pi.sendUserMessage(result.feedback!, {
				deliverAs: "followUp",
			});
			return;
		}

		deactivate(ctx);

		if (result.value === "tdd") {
			pi.sendUserMessage(
				"Let's implement this plan with TDD. Start with step 1.",
				{ deliverAs: "followUp" },
			);
		} else {
			pi.sendUserMessage(
				"Let's implement this plan. Start with step 1.",
				{ deliverAs: "followUp" },
			);
		}
	});

	// ---- Filter stale context when not active ----

	pi.on("context", async (event) => {
		if (enabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as typeof m & { customType?: string };
				return msg.customType !== "plan-mode-context";
			}),
		};
	});

	// ---- Restore state on session start ----

	pi.on("session_start", async (_event, ctx) => {
		planDir = loadPlanDir(ctx.cwd);

		// Restore from persisted state
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e) =>
					e.type === "custom" &&
					(e as { customType?: string }).customType ===
						"plan-mode",
			)
			.pop() as
			| { data?: { enabled: boolean; planDir?: string } }
			| undefined;

		if (last?.data) {
			enabled = last.data.enabled ?? enabled;
			if (last.data.planDir) planDir = last.data.planDir;
		}

		// Flag overrides persisted state — explicit user intent
		if (pi.getFlag("plan") === true) {
			enabled = true;
		}

		if (enabled) {
			pi.setActiveTools(PLAN_TOOLS);
		}

		updateStatus(ctx);
	});
}
