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
 *
 * The VALIDATE_RED sub-phase (checking failure reasons) is handled
 * by context injection — the agent is told to verify the failure
 * reason and stub if needed, re-running until the failure is real.
 * This keeps the state machine simple while the skill provides
 * the nuance.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

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

	// Detect test execution in bash commands
	function looksLikeTestRun(command: string): boolean {
		return /\b(test|jest|vitest|pytest|cargo\s+test|go\s+test|rspec|mocha|ava|tap|phpunit|dotnet\s+test|gradle\s+test|mvn\s+test|mix\s+test|npm\s+t(est)?|yarn\s+test|pnpm\s+test|npx\s+(jest|vitest|mocha))\b/i.test(command);
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
				// Try to count steps from the plan
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

	// ---- Phase transitions via tool observation ----

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		if (!isToolCallEventType("bash", event as any)) return;

		const command = String(
			(event.input as Record<string, unknown>)?.command ?? "",
		);
		if (!looksLikeTestRun(command)) return;

		ranTests = true;
		const failed = event.isError ||
			(event.content?.[0] &&
				"text" in event.content[0] &&
				/fail|error|FAILED/i.test(event.content[0].text));

		if (phase === "red" || phase === "run_red") {
			if (failed) {
				// Tests failed — move to green
				advance("green", ctx);
			}
			// Tests passed in red phase — unusual, context injection
			// will tell the agent the test should be failing
		} else if (phase === "green" || phase === "run_green") {
			if (!failed) {
				// Tests pass — move to refactor gate
				advance("refactor", ctx);
			}
			// Tests still failing — stay in green, agent keeps working
		}
	});

	// ---- Refactor gate ----

	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled || !ctx.hasUI || phase !== "refactor") return;

		const choice = await ctx.ui.select(
			"Tests pass. What next?",
			[
				"Refactor the test",
				"Refactor the implementation",
				"Commit and continue",
				"Commit and stop TDD",
			],
		);

		if (choice === "Refactor the test") {
			pi.sendUserMessage(
				"Refactor the test. Run tests after changes to make sure they still pass.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		if (choice === "Refactor the implementation") {
			pi.sendUserMessage(
				"Refactor the implementation. Run tests after changes to make sure they still pass.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		// Commit — the git-guardian will handle the review
		if (choice === "Commit and stop TDD") {
			pi.sendUserMessage(
				"Commit this work with a well-crafted commit message.",
				{ deliverAs: "followUp" },
			);
			enabled = false;
			updateStatus(ctx);
			persistState();
			return;
		}

		// Commit and continue
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
					(e as { customType?: string }).customType === "tdd-mode",
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
