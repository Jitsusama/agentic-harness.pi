/**
 * Plan Mode Extension
 *
 * Read-only investigation mode for collaborative planning.
 * When active, code modifications are blocked — writes are only
 * allowed to the plan directory. Destructive bash commands are
 * blocked via a blocklist.
 *
 * The planning skill teaches the methodology. This extension
 * enforces the guardrails.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_PLAN_DIR = ".pi/plans";

// Destructive bash patterns — blocked in plan mode.
// Blocklist approach: block known destructive patterns, allow
// everything else. Less surprising than an allowlist.
const DESTRUCTIVE_BASH = [
	/\brm\b/,
	/\brmdir\b/,
	/\bmv\b/,
	/\bmkdir\b/,
	/\btouch\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\btruncate\b/,
	/\bdd\b/,
	/(?:^|[^<])>(?!>)/, // redirect (but not >>)
	/>>/,
	/\btee\b/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)/i,
	/\bsudo\b/,
	/\bkill\b/,
	/\b(vim?|nano|emacs|code|subl)\b/,
];

export default function planMode(pi: ExtensionAPI) {
	let enabled = false;
	let planDir = DEFAULT_PLAN_DIR;
	let wroteToplanDir = false;

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
		return resolved.startsWith(resolvedPlanDir + path.sep) ||
			resolved === resolvedPlanDir;
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
				enabled = false;
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("Plan mode off. Full access restored.");
			} else {
				planDir = loadPlanDir(ctx.cwd);
				enabled = true;
				updateStatus(ctx);
				persistState();
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

	// ---- Tool call interception ----

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;

		// write/edit: allow only to plan directory
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = String(
				(event.input as Record<string, unknown>).path ?? "",
			);
			if (isInPlanDir(filePath, ctx.cwd)) {
				wroteToplanDir = true;
				return; // Allow
			}
			return {
				block: true,
				reason: `Plan mode: writes restricted to ${planDir}/. Exit plan mode with /plan first.`,
			};
		}

		// bash: block destructive commands
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (DESTRUCTIVE_BASH.some((p) => p.test(command))) {
				return {
					block: true,
					reason: "Plan mode: destructive command blocked. Exit plan mode with /plan first.",
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
		if (!enabled || !ctx.hasUI || !wroteToplanDir) return;
		wroteToplanDir = false;

		const choice = await ctx.ui.select("Plan written. What next?", [
			"Implement with TDD",
			"Free-form implementation",
			"Stay in planning",
		]);

		if (choice === "Stay in planning" || !choice) return;

		enabled = false;
		updateStatus(ctx);
		persistState();

		if (choice === "Implement with TDD") {
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

		if (pi.getFlag("plan") === true) {
			enabled = true;
		}

		// Restore from persisted state
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e) =>
					e.type === "custom" &&
					(e as { customType?: string }).customType === "plan-mode",
			)
			.pop() as
			| { data?: { enabled: boolean; planDir?: string } }
			| undefined;

		if (last?.data) {
			enabled = last.data.enabled ?? enabled;
			if (last.data.planDir) planDir = last.data.planDir;
		}

		updateStatus(ctx);
	});
}
