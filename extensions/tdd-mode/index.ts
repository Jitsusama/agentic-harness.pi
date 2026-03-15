/**
 * TDD Mode Extension
 *
 * Skill-driven red-green-refactor tracking with LLM-facing
 * enforcement. The agent calls the tdd_phase tool to signal
 * state transitions. Phase-inappropriate file writes are
 * blocked with hints back to the LLM.
 *
 * Phases:
 *   RED → GREEN → REFACTOR → (done) → RED
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	activate,
	advance,
	deactivate,
	nextCycle,
	restore,
	toggle,
} from "./lifecycle.js";
import { showRefactorGate } from "./refactor-gate.js";
import {
	createTddState,
	PHASE_COLORS,
	PHASE_GLYPH,
	PHASE_STAY,
	type Phase,
} from "./state.js";
import {
	buildTddContext,
	showTransitionGate,
	tddContextFilter,
} from "./transitions.js";

/** Build a tool result when the user declines a phase transition. */
function stayResult(phase: Phase, feedback?: string) {
	const stay = PHASE_STAY[phase];
	const hint = feedback
		? `User feedback: ${feedback}\n\n${stay} Do not attempt to transition again unless the user asks.`
		: `Staying in ${phase.toUpperCase()}. ${stay} Do not attempt to transition again unless the user asks.`;
	return {
		content: [{ type: "text" as const, text: hint }],
		details: { action: phase, stayed: true },
	};
}

export default function tddMode(pi: ExtensionAPI) {
	const state = createTddState();

	// ---- Tool ----

	pi.registerTool({
		name: "tdd_phase",
		label: "TDD Phase",
		description: "Signal TDD phase transitions",
		promptSnippet:
			"Signal TDD phase transitions. Read the tdd-workflow skill for methodology.",
		promptGuidelines: [
			"In REFACTOR phase, call tdd_refactor to propose refactorings. Apply what gets approved, run tests, then call tdd_refactor again. Keep looping until the user selects nothing. Only then signal done.",
			"When signaling green, include test failure output in the summary. When signaling refactor, include test pass confirmation.",
			"Always provide a summary parameter describing what was accomplished in the current phase.",
		],
		parameters: Type.Object({
			action: StringEnum(
				["start", "red", "green", "refactor", "done", "stop"] as const,
				{ description: "The phase transition to signal" },
			),
			context: Type.Optional(
				Type.String({
					description:
						"What is being tested — displayed to the user as a status indicator",
				}),
			),
			summary: Type.Optional(
				Type.String({
					description:
						"What was accomplished in the current phase — shown to the user in the transition gate. Supports markdown.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, context, summary } = params;

			if (action === "start") {
				if (state.enabled) {
					return {
						content: [{ type: "text", text: "TDD mode is already active." }],
					};
				}
				activate(state, pi, ctx, context ?? null);
				return {
					content: [{ type: "text", text: "TDD mode activated." }],
					details: { action: "start", context },
				};
			}

			if (!state.enabled) {
				return {
					content: [
						{
							type: "text",
							text: "TDD mode is not active. Call with action 'start' first.",
						},
					],
				};
			}

			if (action === "stop") {
				const gate = await showTransitionGate(state, ctx, {
					summary: summary ?? "Ending TDD session.",
					nextPhase: "stop",
				});
				if (!gate.approved) {
					return stayResult(state.phase, gate.feedback);
				}
				deactivate(state, pi, ctx);
				return {
					content: [{ type: "text", text: "TDD mode deactivated." }],
					details: { action: "stop", summary },
				};
			}

			if (action === "red") {
				// Skip gate when already in RED (e.g. after start, or updating context)
				if (state.phase !== "red") {
					const gate = await showTransitionGate(state, ctx, {
						summary: summary ?? "Starting new test.",
						nextPhase: "red",
						nextContext: context,
					});
					if (!gate.approved) {
						return stayResult(state.phase, gate.feedback);
					}
				}
				if (context) state.testDescription = context;
				advance(state, "red", pi, ctx);
				return {
					content: [{ type: "text", text: "RED." }],
					details: { action: "red", context, summary },
				};
			}

			if (action === "green") {
				const gate = await showTransitionGate(state, ctx, {
					summary: summary ?? "Test fails for the right reason.",
					nextPhase: "green",
					nextContext: context,
				});
				if (!gate.approved) {
					return stayResult(state.phase, gate.feedback);
				}
				if (context) state.testDescription = context;
				advance(state, "green", pi, ctx);
				return {
					content: [{ type: "text", text: "GREEN." }],
					details: { action: "green", context, summary },
				};
			}

			if (action === "refactor") {
				const gate = await showTransitionGate(state, ctx, {
					summary: summary ?? "Tests pass with minimum implementation.",
					nextPhase: "refactor",
				});
				if (!gate.approved) {
					return stayResult(state.phase, gate.feedback);
				}
				advance(state, "refactor", pi, ctx);
				return {
					content: [{ type: "text", text: "REFACTOR." }],
					details: { action: "refactor", summary },
				};
			}

			if (action === "done") {
				const gate = await showTransitionGate(state, ctx, {
					summary: summary ?? "Refactoring complete.",
					nextPhase: "red",
					nextContext: context,
				});
				if (!gate.approved) {
					return stayResult(state.phase, gate.feedback);
				}
				nextCycle(state, pi, ctx, context ?? null);
				return {
					content: [{ type: "text", text: "Done." }],
					details: { action: "done", context, summary },
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
			};
		},

		renderCall(args, options, theme) {
			const a = args as { action?: string; context?: string };
			const action = a.action ?? "?";
			const color = PHASE_COLORS[action as Phase];
			const glyph = color
				? theme.fg(color, PHASE_GLYPH)
				: action === "done"
					? theme.fg("success", "✓")
					: action === "stop"
						? theme.fg("dim", "■")
						: "";
			let text = theme.fg("toolTitle", theme.bold("tdd_phase "));
			text += `${glyph} ${action}`;
			if (a.context) {
				const maxWidth = options.terminalWidth ?? 80;
				const prefixLen = 15; // Approximate length of "tdd_phase 🔴 red — "
				const availableWidth = maxWidth - prefixLen;
				const contextText =
					a.context.length > availableWidth
						? `${a.context.slice(0, availableWidth - 3)}...`
						: a.context;
				text += theme.fg("dim", ` — ${contextText}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme) {
			const d = result.details as
				| {
						action?: string;
						context?: string;
						summary?: string;
						stayed?: boolean;
				  }
				| undefined;
			if (!d) {
				const t = result.content?.[0];
				return new Text(t && "text" in t ? t.text : "", 0, 0);
			}

			if (d.stayed) {
				const action = d.action ?? "";
				return new Text(
					theme.fg("warning", `↩ Staying in ${action.toUpperCase()}`),
					0,
					0,
				);
			}

			// Summary only — the call renderer already shows action + context
			// Take only the first line and truncate to terminal width
			if (d.summary) {
				const firstLine = d.summary.split("\n")[0] ?? "";
				const maxWidth = options.terminalWidth ?? 80;
				const truncated =
					firstLine.length > maxWidth - 10
						? `${firstLine.slice(0, maxWidth - 13)}...`
						: firstLine;
				return new Text(theme.fg("muted", truncated), 0, 0);
			}
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	// ---- Refactor tool ----

	const RefactorSuggestionSchema = Type.Object({
		label: Type.String({ description: "Short name for the refactoring" }),
		description: Type.String({
			description: "What would be changed and why. Supports markdown.",
		}),
	});

	pi.registerTool({
		name: "tdd_refactor",
		label: "TDD Refactor",
		description:
			"Present refactoring suggestions for user review during REFACTOR phase. Only include actual code changes as suggestions — never include 'skip', 'no changes', or 'done' options. The tool has its own Done page for exiting.",
		promptSnippet:
			"Present refactoring suggestions as a tabbed review. Use in REFACTOR phase. Never include skip/done suggestions — only real code changes.",
		parameters: Type.Object({
			suggestions: Type.Array(RefactorSuggestionSchema, {
				description:
					"Refactoring suggestions. May be empty — the user can still add their own.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.enabled || state.phase !== "refactor") {
				return {
					content: [
						{
							type: "text",
							text: "tdd_refactor can only be used during REFACTOR phase.",
						},
					],
				};
			}

			const result = await showRefactorGate(ctx, params.suggestions);

			if (!result) {
				return {
					content: [{ type: "text", text: "Cancelled." }],
				};
			}

			if (result.approved.length === 0 && result.userSuggestions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "User is satisfied. Signal done to complete the cycle.",
						},
					],
					details: { approved: [], satisfied: true },
				};
			}

			const lines: string[] = [];
			const approved = result.approved.map((s) => s.label);

			for (const s of result.approved) {
				lines.push(`- ${s.label}: ${s.description}`);
			}

			for (let i = 0; i < result.userSuggestions.length; i++) {
				const userSuggestion = result.userSuggestions[i];
				if (userSuggestion) {
					lines.push(`- User suggestion ${i + 1}: ${userSuggestion}`);
					approved.push(`User: ${userSuggestion}`);
				}
			}

			lines.push(
				"",
				"Apply these refactorings, run tests, then call tdd_refactor again for another round.",
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					approved,
					rejected: result.rejected,
					userSuggestionsCount: result.userSuggestions.length,
				},
			};
		},

		renderCall(args, theme) {
			const a = args as { suggestions?: { label: string }[] };
			const count = a.suggestions?.length ?? 0;
			let text = theme.fg("toolTitle", theme.bold("tdd_refactor "));
			text += theme.fg(
				"muted",
				count > 0
					? `${count} suggestion${count !== 1 ? "s" : ""}`
					: "open floor",
			);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as
				| {
						approved?: string[];
						rejected?: number;
						satisfied?: boolean;
						userSuggestionsCount?: number;
				  }
				| undefined;
			if (!d) {
				const t = result.content?.[0];
				return new Text(t && "text" in t ? t.text : "", 0, 0);
			}
			if (d.satisfied) {
				return new Text(
					theme.fg("success", "✓ No refactorings — moving on"),
					0,
					0,
				);
			}
			const lines: string[] = [];
			for (const label of d.approved ?? []) {
				lines.push(`${theme.fg("success", "✓")} ${label}`);
			}
			if (d.rejected && d.rejected > 0) {
				lines.push(theme.fg("dim", `✗ ${d.rejected} rejected`));
			}
			if (d.userSuggestionsCount && d.userSuggestionsCount > 0) {
				lines.push(theme.fg("accent", `+ ${d.userSuggestionsCount} yours`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ---- Commands ----

	pi.registerCommand("tdd", {
		description: "Toggle TDD mode, optionally with a plan file",
		handler: async (args, ctx) =>
			toggle(state, pi, ctx, args?.trim() || undefined),
	});

	pi.registerCommand("tdd-test-refactor", {
		description: "Test refactor gate with scenarios: none, one, two",
		handler: async (args, ctx) => {
			const scenario = args?.trim() || "one";
			let suggestions: { label: string; description: string }[] = [];

			switch (scenario) {
				case "none":
					suggestions = [];
					break;
				case "one":
					suggestions = [
						{
							label: "Extract method",
							description:
								"Extract the repeated query logic into a separate method `buildPartitionQuery` for better reusability.",
						},
					];
					break;
				case "two":
					suggestions = [
						{
							label: "Extract method",
							description:
								"Extract the repeated query logic into a separate method `buildPartitionQuery`.",
						},
						{
							label: "Add validation",
							description:
								"Add input validation to ensure partition_ids is not empty before executing the query.",
						},
					];
					break;
				default:
					ctx.ui.notify(`Unknown scenario: ${scenario}`, "error");
					ctx.ui.notify("Usage: tdd-test-refactor [none|one|two]", "info");
					return;
			}

			ctx.ui.notify(
				`Testing refactor gate with "${scenario}" scenario...`,
				"info",
			);
			const result = await showRefactorGate(ctx, suggestions);

			if (!result) {
				ctx.ui.notify("Result: Cancelled", "info");
				return;
			}

			const lines: string[] = [];
			lines.push("Result:");
			lines.push(`  Approved: ${result.approved.length}`);
			for (const s of result.approved) {
				lines.push(`    - ${s.label}`);
			}
			lines.push(`  Rejected: ${result.rejected}`);
			lines.push(`  User suggestions: ${result.userSuggestions.length}`);
			for (let i = 0; i < result.userSuggestions.length; i++) {
				const s = result.userSuggestions[i];
				if (s) {
					// Show first 60 chars
					const preview = s.length > 60 ? `${s.slice(0, 60)}...` : s;
					lines.push(`    ${i + 1}. ${preview}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "success");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Toggle TDD mode",
		handler: async (ctx) => toggle(state, pi, ctx),
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
