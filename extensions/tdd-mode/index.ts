/**
 * TDD Mode Extension
 *
 * Red-green-refactor state machine with phase enforcement.
 * The TDD workflow skill teaches the methodology. This extension
 * enforces the discipline and adds the refactor gate + commit
 * proposal.
 *
 * Phases:
 *   RED → RUN_RED → GREEN → RUN_GREEN → REFACTOR → (commit) → RED
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
// Dynamic import — static imports from sibling dirs crash
// extension loading under pi's jiti module resolution.
let _gate: typeof import("../shared/gate.js") | null = null;
async function getGate() {
	if (!_gate) _gate = await import("../shared/gate.js");
	return _gate;
}

type Phase =
	| "red"
	| "run_red"
	| "green"
	| "run_green"
	| "refactor";

const PHASE_LABELS: Record<Phase, string> = {
	red: "🔴 RED",
	run_red: "🔴 RUN RED",
	green: "🟢 GREEN",
	run_green: "🟢 RUN GREEN",
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
	run_red: [
		"Run the test. It should fail. Verify the failure is",
		"because the functionality doesn't exist yet — not a",
		"syntax error, import error, or test infrastructure issue.",
		"If the failure is wrong, stub just enough and re-run.",
	].join(" "),
	green: [
		"Write the minimum code to make the test pass. No more.",
		"Don't anticipate future needs. When done, run the tests.",
	].join(" "),
	run_green: [
		"Run the tests. They should all pass. If not, fix the",
		"implementation (not the test) and re-run.",
	].join(" "),
	refactor: [
		"Tests pass. Present the current state to the user.",
		"Wait for the user to decide: refactor the test, refactor",
		"the implementation, or move on. Run tests after each",
		"refactor change.",
	].join(" "),
};

// ---- Test file detection ----

const TEST_PATTERNS = [
	/[._-]test\./i,
	/[._-]spec\./i,
	/\.test\./i,
	/\.spec\./i,
	/\/__tests__\//,
	/\/tests?\//,
	/\/spec\//,
];

function isTestFile(filePath: string): boolean {
	return TEST_PATTERNS.some((p) => p.test(filePath));
}

export default function tddMode(pi: ExtensionAPI) {
	let enabled = false;
	let phase: Phase = "red";
	let cycle = 1;
	let planFile: string | null = null;
	let totalSteps: number | null = null;
	let ranTests = false;

	// ---- Helpers ----

	function statusText(ctx: ExtensionContext): string {
		const label = PHASE_LABELS[phase];
		const stepInfo = totalSteps
			? `Step ${cycle}/${totalSteps}`
			: `Cycle ${cycle}`;
		return ctx.ui.theme.fg("accent", `${label} — ${stepInfo}`);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"tdd-mode",
			enabled ? statusText(ctx) : undefined,
		);
	}

	function persistState(): void {
		pi.appendEntry("tdd-mode", {
			enabled,
			phase,
			cycle,
			planFile,
			totalSteps,
		});
	}

	function advance(next: Phase, ctx: ExtensionContext): void {
		phase = next;
		ranTests = false;
		updateStatus(ctx);
	}

	function nextCycle(ctx: ExtensionContext): void {
		cycle++;
		phase = "red";
		ranTests = false;
		updateStatus(ctx);
		persistState();
	}

	function looksLikeTestRun(command: string): boolean {
		return /\b(test|jest|vitest|pytest|cargo\s+test|go\s+test|rspec|mocha|ava|tap|phpunit|dotnet\s+test|gradle\s+test|mvn\s+test|mix\s+test|npm\s+t(est)?|yarn\s+test|pnpm\s+test|npx\s+(jest|vitest|mocha))\b/i.test(
			command,
		);
	}

	// ---- Commands ----

	pi.registerCommand("tdd", {
		description: "Toggle TDD mode, optionally with a plan file",
		handler: async (args, ctx) => {
			if (enabled) {
				enabled = false;
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("TDD mode off.");
				return;
			}

			enabled = true;
			phase = "red";
			cycle = 1;
			ranTests = false;

			if (args?.trim()) {
				planFile = args.trim();
				try {
					const { readFileSync } = await import("node:fs");
					const content = readFileSync(planFile, "utf-8");
					const steps = content.match(/^\s*\d+\.\s+/gm);
					totalSteps = steps?.length ?? null;
				} catch {
					totalSteps = null;
				}
			} else {
				planFile = null;
				totalSteps = null;
			}

			updateStatus(ctx);
			persistState();
			ctx.ui.notify(
				planFile
					? `TDD mode on. Plan: ${planFile} (${totalSteps ?? "?"} steps)`
					: "TDD mode on.",
			);
		},
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Toggle TDD mode",
		handler: async (ctx) => {
			if (enabled) {
				enabled = false;
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("TDD mode off.");
			} else {
				enabled = true;
				phase = "red";
				cycle = 1;
				ranTests = false;
				planFile = null;
				totalSteps = null;
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("TDD mode on.");
			}
		},
	});

	// ---- RED phase file restriction ----

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		if (phase !== "red" && phase !== "run_red") return;
		if (event.toolName !== "write" && event.toolName !== "edit")
			return;

		const filePath = String(
			(event.input as Record<string, unknown>).path ?? "",
		);
		if (isTestFile(filePath)) return; // Allow test files

		// Non-test file in RED phase — confirm it's a stub
		if (!ctx.hasUI) return;
		const { showGate, formatSteer } = await getGate();
		const result = await showGate(ctx, {
			content: (theme, _width) => [
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
				reason: `RED phase: write to implementation file blocked. Only test files and minimal stubs allowed. File: ${filePath}`,
			};
		}

		if (result.value === "steer") {
			return formatSteer(
				result.feedback!,
				`Blocked write to ${filePath} during RED phase.`,
			);
		}

		// Allow — user confirmed it's a stub
		return;
	});

	// ---- Phase transitions via tool observation ----

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		if (!isToolCallEventType("bash", event as any)) return;

		const command = String(
			(event.input as Record<string, unknown>)?.command ?? "",
		);
		if (!looksLikeTestRun(command)) return;

		ranTests = true;
		const failed =
			event.isError ||
			(event.content?.[0] &&
				"text" in event.content[0] &&
				/fail|error|FAILED/i.test(event.content[0].text));

		if (phase === "red" || phase === "run_red") {
			if (failed) {
				advance("green", ctx);
			}
		} else if (phase === "green" || phase === "run_green") {
			if (!failed) {
				advance("refactor", ctx);
			}
		}
	});

	// ---- Refactor gate ----

	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled || !ctx.hasUI || phase !== "refactor") return;

		const { showGate } = await getGate();
		const result = await showGate(ctx, {
			content: (theme, _width) => [
				theme.fg("text", " Tests pass."),
			],
			options: [
				{ label: "Refactor the test", value: "refactor-test" },
				{
					label: "Refactor the implementation",
					value: "refactor-impl",
				},
				{ label: "Commit and continue", value: "commit-continue" },
				{ label: "Commit and stop TDD", value: "commit-stop" },
			],
			steerContext: "",
		});

		if (!result) return;

		if (result.value === "steer") {
			pi.sendUserMessage(result.feedback!, {
				deliverAs: "followUp",
			});
			return;
		}

		if (result.value === "refactor-test") {
			pi.sendUserMessage(
				"Refactor the test. Run tests after changes to make sure they still pass.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		if (result.value === "refactor-impl") {
			pi.sendUserMessage(
				"Refactor the implementation. Run tests after changes to make sure they still pass.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		if (result.value === "commit-stop") {
			pi.sendUserMessage(
				"Commit this work with a well-crafted commit message.",
				{ deliverAs: "followUp" },
			);
			enabled = false;
			updateStatus(ctx);
			persistState();
			return;
		}

		// commit-continue
		nextCycle(ctx);
		const stepContext = totalSteps
			? ` Move on to step ${cycle}.`
			: "";
		pi.sendUserMessage(
			`Commit this work with a well-crafted commit message.${stepContext}`,
			{ deliverAs: "followUp" },
		);
	});

	// ---- Context injection ----

	pi.on("before_agent_start", async () => {
		if (!enabled) return;

		const planContext = planFile
			? `\nPlan file: ${planFile} — refer to it for the current step.`
			: "";

		return {
			message: {
				customType: "tdd-mode-context",
				content: [
					`[TDD MODE — ${PHASE_LABELS[phase]}]`,
					"",
					PHASE_INSTRUCTIONS[phase],
					planContext,
				]
					.filter(Boolean)
					.join("\n"),
				display: false,
			},
		};
	});

	// ---- Filter stale context ----

	pi.on("context", async (event) => {
		if (enabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as typeof m & { customType?: string };
				return msg.customType !== "tdd-mode-context";
			}),
		};
	});

	// ---- Restore state ----

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e) =>
					e.type === "custom" &&
					(e as { customType?: string }).customType ===
						"tdd-mode",
			)
			.pop() as
			| {
					data?: {
						enabled: boolean;
						phase: Phase;
						cycle: number;
						planFile: string | null;
						totalSteps: number | null;
					};
			  }
			| undefined;

		if (last?.data) {
			enabled = last.data.enabled ?? false;
			phase = last.data.phase ?? "red";
			cycle = last.data.cycle ?? 1;
			planFile = last.data.planFile ?? null;
			totalSteps = last.data.totalSteps ?? null;
		}

		updateStatus(ctx);
	});
}
