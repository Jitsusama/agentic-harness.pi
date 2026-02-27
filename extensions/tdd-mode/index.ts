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
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { showGate, formatSteer } from "../shared/gate.js";
import { getLastEntry, filterContext } from "../shared/state.js";
import { isTestFile, looksLikeTestRun } from "./patterns.js";

// ---- Phase definitions ----

type Phase = "red" | "green" | "refactor";

const PHASE_LABELS: Record<Phase, string> = {
	red: "🔴 RED",
	green: "🟢 GREEN",
	refactor: "🔄 REFACTOR",
};

const PHASE_INSTRUCTIONS: Record<Phase, string> = {
	red: [
		"Write a test that describes the desired behavior.",
		"Only create or modify test files. Minimal stubs in",
		"implementation files are allowed if needed to get the",
		"test to fail for the right reason.",
		"When the test is written, run it to verify it fails.",
	].join(" "),
	green: [
		"Write the minimum code to make the test pass. No more.",
		"Don't anticipate future needs. When done, run the tests.",
	].join(" "),
	refactor: [
		"Tests pass. Present the current state to the user.",
		"Wait for the user to decide: refactor the test, refactor",
		"the implementation, or move on. Run tests after each",
		"refactor change.",
	].join(" "),
};

// ---- Extension ----

export default function tddMode(pi: ExtensionAPI) {
	let enabled = false;
	let phase: Phase = "red";
	let cycle = 1;
	let planFile: string | null = null;
	let totalSteps: number | null = null;

	// ---- Helpers ----

	function statusText(ctx: ExtensionContext): string {
		const label = PHASE_LABELS[phase];
		const step = totalSteps ? `Step ${cycle}/${totalSteps}` : `Cycle ${cycle}`;
		return ctx.ui.theme.fg("accent", `${label} — ${step}`);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("tdd-mode", enabled ? statusText(ctx) : undefined);
	}

	function persist(): void {
		pi.appendEntry("tdd-mode", { enabled, phase, cycle, planFile, totalSteps });
	}

	function activate(ctx: ExtensionContext, plan?: string): void {
		enabled = true;
		phase = "red";
		cycle = 1;
		planFile = plan ?? null;
		totalSteps = null;

		if (planFile) {
			try {
				const content = require("node:fs").readFileSync(planFile, "utf-8");
				const steps = content.match(/^\s*\d+\.\s+/gm);
				totalSteps = steps?.length ?? null;
			} catch {}
		}

		updateStatus(ctx);
		persist();
	}

	function deactivate(ctx: ExtensionContext): void {
		enabled = false;
		updateStatus(ctx);
		persist();
	}

	function toggle(ctx: ExtensionContext, plan?: string): void {
		if (enabled) {
			deactivate(ctx);
			ctx.ui.notify("TDD mode off.");
		} else {
			activate(ctx, plan);
			ctx.ui.notify(
				planFile
					? `TDD mode on. Plan: ${planFile} (${totalSteps ?? "?"} steps)`
					: "TDD mode on.",
			);
		}
	}

	function advance(next: Phase, ctx: ExtensionContext): void {
		phase = next;
		updateStatus(ctx);
	}

	function nextCycle(ctx: ExtensionContext): void {
		cycle++;
		phase = "red";
		updateStatus(ctx);
		persist();
	}

	// ---- Commands ----

	pi.registerCommand("tdd", {
		description: "Toggle TDD mode, optionally with a plan file",
		handler: async (args, ctx) => toggle(ctx, args?.trim() || undefined),
	});

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Toggle TDD mode",
		handler: async (ctx) => toggle(ctx),
	});

	// ---- RED phase file restriction ----

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || phase !== "red") return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const filePath = String(
			(event.input as Record<string, unknown>).path ?? "",
		);
		if (isTestFile(filePath)) return;
		if (!ctx.hasUI) return;

		const result = await showGate(ctx, {
			content: (theme) => [
				theme.fg("warning", " Implementation file in RED phase"),
				"",
				` ${theme.fg("text", filePath)}`,
				` ${theme.fg("muted", "RED phase is for tests and minimal stubs only.")}`,
			],
			options: [
				{ label: "Allow — minimal stub", value: "allow" },
				{ label: "Block", value: "block" },
			],
			steerContext: `File: ${filePath}\nPhase: RED — should only modify test files and minimal stubs.`,
		});

		if (!result || result.value === "block") {
			return {
				block: true,
				reason: `RED phase: write to implementation file blocked. File: ${filePath}`,
			};
		}

		if (result.value === "steer") {
			return formatSteer(result.feedback!, `Blocked write to ${filePath} during RED phase.`);
		}
	});

	// ---- Phase transitions via test results ----

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		if (!isBashToolResult(event)) return;

		const command = String(event.input?.command ?? "");
		if (!looksLikeTestRun(command)) return;

		const failed =
			event.isError ||
			(event.content?.[0] &&
				"text" in event.content[0] &&
				/fail|error|FAILED/i.test(event.content[0].text));

		if (phase === "red" && failed) {
			advance("green", ctx);
		} else if (phase === "green" && !failed) {
			advance("refactor", ctx);
		}
	});

	// ---- Refactor gate ----

	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled || !ctx.hasUI || phase !== "refactor") return;

		const result = await showGate(ctx, {
			content: (theme) => [theme.fg("text", " Tests pass.")],
			options: [
				{ label: "Refactor the test", value: "refactor-test" },
				{ label: "Refactor the implementation", value: "refactor-impl" },
				{ label: "Commit and continue", value: "commit-continue" },
				{ label: "Commit and stop TDD", value: "commit-stop" },
			],
			steerContext: "",
		});

		if (!result) return;

		if (result.value === "steer") {
			pi.sendUserMessage(result.feedback!, { deliverAs: "followUp" });
			return;
		}

		if (result.value === "refactor-test") {
			pi.sendUserMessage(
				"Refactor the test. Run tests after changes.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		if (result.value === "refactor-impl") {
			pi.sendUserMessage(
				"Refactor the implementation. Run tests after changes.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		if (result.value === "commit-stop") {
			deactivate(ctx);
			pi.sendUserMessage(
				"Commit this work with a well-crafted commit message.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		// commit-continue
		nextCycle(ctx);
		const step = totalSteps ? ` Move on to step ${cycle}.` : "";
		pi.sendUserMessage(
			`Commit this work with a well-crafted commit message.${step}`,
			{ deliverAs: "followUp" },
		);
	});

	// ---- Context injection ----

	pi.on("before_agent_start", async () => {
		if (!enabled) return;

		const planNote = planFile
			? `\nPlan file: ${planFile} — refer to it for the current step.`
			: "";

		return {
			message: {
				customType: "tdd-mode-context",
				content: [
					`[TDD MODE — ${PHASE_LABELS[phase]}]`,
					"",
					PHASE_INSTRUCTIONS[phase],
					planNote,
				].filter(Boolean).join("\n"),
				display: false,
			},
		};
	});

	pi.on("context", filterContext("tdd-mode-context", () => enabled));

	// ---- Restore state ----

	interface TddState {
		enabled: boolean;
		phase: Phase;
		cycle: number;
		planFile: string | null;
		totalSteps: number | null;
	}

	pi.on("session_start", async (_event, ctx) => {
		const saved = getLastEntry<TddState>(ctx, "tdd-mode");
		if (saved) {
			enabled = saved.enabled ?? false;
			phase = saved.phase ?? "red";
			cycle = saved.cycle ?? 1;
			planFile = saved.planFile ?? null;
			totalSteps = saved.totalSteps ?? null;
		}
		updateStatus(ctx);
	});
}
