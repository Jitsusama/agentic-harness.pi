/**
 * Plan Workflow Extension
 *
 * Collaborative planning as a persistent, staged workflow rather
 * than a one-shot gate. A plan moves through think (read-only:
 * dig and debate), plan (draft the document) and build
 * (implement), and can return to think to replan. The plan
 * document is the single source of truth: it survives reloads,
 * resumes and cold starts, and the workflow rehydrates from it.
 *
 * It is a tracker, not a turnstile. The only thing it blocks is
 * the agent implementing while a plan is still read-only, and
 * that block is agent-facing, never a human prompt. Questions
 * are plain conversation; there is no interview tool.
 *
 * The planning skill teaches the methodology and the document
 * format. This extension keeps the state, the scoreboard and the
 * read-only guardrail. Plan-file destination is decided by the
 * routing event (see lib/plan-routing), so a personal setup can
 * route plans into its own home.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { enforcePlan } from "./enforce.js";
import {
	applyTransition,
	attach,
	listPlans,
	restore,
	type TransitionParams,
} from "./lifecycle.js";
import { formatPlanList } from "./render.js";
import { createPlanState } from "./state.js";
import { buildPlanContext, planContextFilter } from "./transitions.js";

/** Width fallback for render helpers when the terminal width is unknown. */
const DEFAULT_WIDTH = 80;
/** Columns the call line reserves before the note snippet. */
const CALL_PREFIX_WIDTH = 14;

export default function planWorkflow(pi: ExtensionAPI) {
	const state = createPlanState();

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"Drive collaborative planning through its stages: think, draft, build, conclude, retire.",
		promptSnippet:
			"Drive planning with the plan tool: think (read-only: dig and " +
			"debate), draft (write the plan document), build (implement). " +
			"Questions are plain conversation; there is no interview tool. " +
			"Read the planning skill for methodology.",
		promptGuidelines: [
			"Start with think and dig hard before forming a view. Debate the problem: surface tradeoffs, float alternatives, push back. Ask the user only when something genuinely blocks you, in plain conversation, one thing at a time.",
			"Move to draft once the shape is agreed; the document is the living source of truth, so keep it current. Move to build to implement against it, checking off work and logging discoveries as you go.",
			"Return to think (replan) when discovery invalidates the plan. A change to the spirit or approach needs the user's consent; smaller changes you just make and record.",
			"A refused transition returns guidance and changes nothing. There is no human gate and no approval prompt.",
		],
		parameters: Type.Object({
			action: StringEnum(
				["think", "draft", "build", "conclude", "retire"] as const,
				{ description: "The stage transition to make." },
			),
			note: Type.Optional(
				Type.String({
					description:
						"think: what this plan is about, or what sent you back to thinking.",
				}),
			),
			title: Type.Optional(
				Type.String({
					description:
						"draft: the plan's human title. It becomes the document's H1.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description: "retire: why the plan is being abandoned.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await applyTransition(
				state,
				pi,
				ctx,
				params as TransitionParams,
			);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.guidance }],
					details: { ok: false, guidance: result.guidance },
				};
			}
			const text = result.planPath
				? `In ${state.stage}: ${result.message}\nPlan: ${result.planPath}`
				: `In ${state.stage}: ${result.message}`;
			return {
				content: [{ type: "text", text }],
				details: { ok: true, stage: state.stage, planPath: result.planPath },
			};
		},

		renderCall(args, theme) {
			const a = args as {
				action?: string;
				note?: string;
				title?: string;
				reason?: string;
			};
			const action = a.action ?? "";
			let text = theme.fg("toolTitle", theme.bold("plan "));
			text += theme.fg("text", action);
			const note = a.title ?? a.note ?? a.reason;
			if (note) {
				const room = Math.max(
					0,
					(process.stdout.columns || DEFAULT_WIDTH) -
						CALL_PREFIX_WIDTH -
						action.length,
				);
				text += theme.fg("dim", `: ${truncateToWidth(note, room)}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as
				| { ok?: boolean; stage?: string; guidance?: string }
				| undefined;
			if (d && d.ok === false) {
				return new Text(theme.fg("warning", d.guidance ?? "Refused"), 0, 0);
			}
			const first =
				result.content?.[0] && "text" in result.content[0]
					? result.content[0].text.split("\n")[0]
					: "";
			return new Text(theme.fg("success", first), 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "Show the active plan, or `/plan list` to discover plans",
		handler: async (args, ctx) => {
			if (args?.trim() === "list") {
				const plans = await listPlans(pi, ctx);
				ctx.ui.notify(
					plans.length ? formatPlanList(plans) : "No plans found.",
					"info",
				);
				return;
			}
			ctx.ui.notify(
				state.planPath
					? `Plan ${state.planId} (${state.stage}) → ${state.planPath}`
					: "No active plan.",
				"info",
			);
		},
	});

	pi.registerCommand("plan-attach", {
		description: "Attach to an existing plan by path or id",
		handler: async (args, ctx) => {
			const ref = args?.trim();
			if (!ref) {
				ctx.ui.notify("Usage: /plan-attach <path|id>", "warning");
				return;
			}
			const ok = await attach(state, pi, ctx, ref);
			ctx.ui.notify(
				ok
					? `Attached ${state.planId} (${state.stage}).`
					: `No plan found for "${ref}".`,
				ok ? "info" : "warning",
			);
		},
	});

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> =>
			enforcePlan(
				state,
				event.toolName,
				event.input as Record<string, unknown>,
				ctx.cwd,
			),
	);

	pi.on("before_agent_start", async () => buildPlanContext(state));

	pi.on("context", planContextFilter(state));

	pi.on("session_start", async (_event, ctx) => {
		restore(state, pi, ctx);
	});
}
