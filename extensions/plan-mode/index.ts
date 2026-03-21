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

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { enforcePlanMode } from "./enforce.js";
import { showPlanInterview } from "./interview.js";
import { activate, deactivate, restore, toggle } from "./lifecycle.js";
import { createPlanState } from "./state.js";
import {
	buildPlanContext,
	handlePlanWritten,
	planContextFilter,
} from "./transitions.js";

export default function planMode(pi: ExtensionAPI) {
	const state = createPlanState();

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only investigation)",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: "plan_mode",
		label: "Plan Mode",
		description: "Activate or deactivate plan mode (read-only investigation)",
		promptSnippet:
			"Toggle plan mode for read-only investigation. Read the plan-workflow skill for methodology.",
		parameters: Type.Object({
			action: StringEnum(["activate", "deactivate"] as const, {
				description: "Whether to activate or deactivate plan mode",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "activate") {
				if (state.enabled) {
					return {
						content: [{ type: "text", text: "Plan mode is already active." }],
					};
				}
				activate(state, pi, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Plan mode activated. Writes restricted to ${state.planDir}/. Read-only investigation is now enforced.`,
						},
					],
				};
			}

			if (!state.enabled) {
				return {
					content: [{ type: "text", text: "Plan mode is not active." }],
				};
			}
			deactivate(state, pi, ctx);
			return {
				content: [
					{
						type: "text",
						text: "Plan mode deactivated. All tools restored.",
					},
				],
			};
		},
	});

	const PlanQuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier for this question" }),
		question: Type.String({
			description: "The question to ask. Supports markdown.",
		}),
		context: Type.Optional(
			Type.String({
				description:
					"Why this question matters for the plan. Supports markdown.",
			}),
		),
	});

	pi.registerTool({
		name: "plan_interview",
		label: "Plan Interview",
		description:
			"Present planning questions as a tabbed interview. The user answers, skips, or adds their own. Loop until no questions remain.",
		promptSnippet:
			"Present planning questions as a tabbed interview during plan mode.",
		promptGuidelines: [
			"During planning, use plan_interview to ask clarifying questions instead of asking inline.",
			"Loop: call plan_interview, process answers, call again with follow-up questions. Stop when you have no more questions and the user adds none.",
			"Only include genuine questions: never include 'no questions' or 'skip' options. The tool has its own Done page.",
		],
		parameters: Type.Object({
			questions: Type.Array(PlanQuestionSchema, {
				description:
					"Questions to ask. May be empty: the user can still add their own.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await showPlanInterview(ctx, params.questions);

			if (!result) {
				return {
					content: [{ type: "text", text: "Cancelled." }],
					details: { cancelled: true },
				};
			}

			if (result.allSkipped) {
				return {
					content: [
						{
							type: "text",
							text: "No questions answered and none added. Proceed with planning.",
						},
					],
					details: { answers: [], satisfied: true },
				};
			}

			const lines: string[] = [];

			for (const a of result.answers) {
				lines.push(`Q: ${a.question}`);
				lines.push(`A: ${a.answer}`);
				lines.push("");
			}

			for (const uq of result.userQuestions) {
				lines.push(`User question: ${uq}`);
				lines.push("");
			}

			if (result.userQuestions.length > 0) {
				lines.push(
					"Answer the user's questions, then call plan_interview again with any follow-up questions.",
				);
			} else {
				lines.push(
					"Process these answers. Call plan_interview again if you have follow-up questions, or proceed with the plan.",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					answers: result.answers.map((a) => ({
						id: a.id,
						question: a.question,
					})),
					userQuestions: result.userQuestions,
				},
			};
		},

		renderCall(args, theme) {
			const a = args as { questions?: { id: string }[] };
			const count = a.questions?.length ?? 0;
			let text = theme.fg("toolTitle", theme.bold("plan_interview "));
			text += theme.fg(
				"muted",
				count > 0 ? `${count} question${count !== 1 ? "s" : ""}` : "open floor",
			);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as
				| {
						answers?: { id: string; question: string }[];
						userQuestions?: string[];
						satisfied?: boolean;
						cancelled?: boolean;
				  }
				| undefined;
			if (!d) {
				const t = result.content?.[0];
				return new Text(t && "text" in t ? t.text : "", 0, 0);
			}
			if (d.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			if (d.satisfied) {
				return new Text(
					theme.fg("success", "✓ No questions: proceeding"),
					0,
					0,
				);
			}
			const lines: string[] = [];
			for (const a of d.answers ?? []) {
				lines.push(`${theme.fg("success", "✓")} ${a.question}`);
			}
			for (const uq of d.userQuestions ?? []) {
				lines.push(`${theme.fg("accent", "?")} ${uq}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

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

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => toggle(state, pi, ctx),
	});

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			return enforcePlanMode(
				state,
				event.toolName,
				event.input as Record<string, unknown>,
				ctx.cwd,
			);
		},
	);

	pi.on("agent_end", async (_event, ctx) => {
		await handlePlanWritten(state, pi, ctx);
	});

	pi.on("before_agent_start", async () => {
		return buildPlanContext(state);
	});

	pi.on("context", planContextFilter(state));

	pi.on("session_start", async (_event, ctx) => {
		restore(state, pi, ctx);
	});
}
