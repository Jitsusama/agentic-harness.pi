/**
 * Correction Capture Extension
 *
 * Turns the steering you do in a session into durable behavioural
 * rules. When you ask the agent to remember a lesson, it calls
 * `capture_lesson`, which distills the corrections in the current
 * session into drafted rules using a cheap side model, shows them
 * back for you to edit by talking, and files the ones you approve
 * into the governance rule store.
 *
 * The store is user-global and human-editable. Its rules ride the
 * prompt coordinator as a resident block, so a lesson captured in
 * one session is standing guidance in the next, and they are the
 * watch-list the advisor reviews turns against. There is no
 * command; you drive it by talking.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { runSideCompletion } from "../../lib/completion/index.js";
import {
	condenseTranscript,
	distillSystemPrompt,
	distillUserPrompt,
	openRuleStore,
	parseRules,
	type RuleStore,
	renderRulesBlock,
	type Turn,
} from "../../lib/governance/index.js";
import { dataDir } from "../../lib/internal/paths.js";
import { registerPromptContributor } from "../../lib/prompt/index.js";
import { entriesToTurns } from "./transcript.js";

/** Captured lessons sit just below the enforced conventions. */
const GOVERNANCE_ORDER = 1;

/** Text content out of a tool result, for rendering. */
interface CaptureDetails {
	readonly action: "draft" | "file" | "list" | "remove";
	readonly count?: number;
}

function isDetails(d: unknown): d is CaptureDetails {
	return typeof d === "object" && d !== null && "action" in d;
}

export default function correctionCapture(pi: ExtensionAPI) {
	let store: RuleStore | null = null;
	function ruleStore(): RuleStore {
		if (!store) {
			const dir = dataDir("governance");
			mkdirSync(dir, { recursive: true });
			store = openRuleStore(join(dir, "rules.json"));
		}
		return store;
	}

	// Filed rules ride the resident prompt so a lesson captured in
	// one session is standing guidance in the next. Reading the
	// store at assembly time means the block reflects the rules on
	// disk without a restart.
	registerPromptContributor({
		id: "governance-rules",
		order: GOVERNANCE_ORDER,
		async contribute() {
			return renderRulesBlock(ruleStore().list());
		},
	});

	pi.registerTool({
		name: "capture_lesson",
		label: "Capture Lesson",
		description:
			"Capture behavioural lessons from this session as durable rules. " +
			"With no arguments, distills the corrections in the session into " +
			"drafted rules and returns them for review without filing (show " +
			"them to the user, refine by talking, then call again with " +
			"`rules` to file). Pass `rules` to file the approved rules, " +
			"`list` to see filed rules, or `remove` with a rule id to delete " +
			"one. Invoke when the user asks you to remember a lesson or turn " +
			"a correction into a rule.",
		promptSnippet:
			"Capture behavioural lessons from the session into durable rules.",
		promptGuidelines: [
			"When the user asks you to remember a lesson, first call capture_lesson with no rules to draft, show the draft, refine by talking, then call again with the approved rules to file.",
			"Never file a rule the user has not seen and approved.",
		],
		parameters: Type.Object({
			rules: Type.Optional(
				Type.Array(Type.String(), {
					description: "Approved rule texts to file into the store.",
				}),
			),
			focus: Type.Optional(
				Type.String({
					description: "What to focus on when distilling a draft.",
				}),
			),
			list: Type.Optional(
				Type.Boolean({ description: "Return the filed rules." }),
			),
			remove: Type.Optional(
				Type.String({ description: "Id of a filed rule to remove." }),
			),
		}),

		renderCall(args, theme) {
			const label = theme.fg("toolTitle", theme.bold("capture_lesson "));
			const mode = args.rules
				? "file"
				: args.list
					? "list"
					: args.remove
						? "remove"
						: "draft";
			return new Text(label + theme.fg("dim", mode), 0, 0);
		},

		renderResult(result, _options, theme) {
			const first = result.content?.[0];
			const text = first && first.type === "text" ? first.text : "";
			const colour = isDetails(result.details) ? "success" : "text";
			return new Text(theme.fg(colour, text), 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rules = ruleStore();

			if (params.list) {
				const all = rules.list();
				const body = all.length
					? all.map((r) => `- [${r.id}] ${r.text}`).join("\n")
					: "No rules filed yet.";
				return {
					content: [{ type: "text" as const, text: body }],
					details: {
						action: "list",
						count: all.length,
					} satisfies CaptureDetails,
				};
			}

			if (params.remove) {
				const removed = rules.remove(params.remove);
				return {
					content: [
						{
							type: "text" as const,
							text: removed
								? `Removed rule ${params.remove}.`
								: `No rule with id ${params.remove}.`,
						},
					],
					details: { action: "remove" } satisfies CaptureDetails,
				};
			}

			if (params.rules && params.rules.length > 0) {
				const filed = params.rules
					.map((text) => text.trim())
					.filter((text) => text.length > 0)
					.map((text) => {
						// sessionId is present at runtime but absent from
						// the older typecheck types; read it defensively.
						const sessionId = (ctx as { sessionId?: string }).sessionId;
						return rules.add({
							text,
							...(sessionId ? { source: `capture:${sessionId}` } : {}),
						});
					});
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Filed ${filed.length} rule(s):\n` +
								filed.map((r) => `- [${r.id}] ${r.text}`).join("\n"),
						},
					],
					details: {
						action: "file",
						count: filed.length,
					} satisfies CaptureDetails,
				};
			}

			// Draft mode: distill the session into candidate rules.
			const turns: Turn[] = entriesToTurns(ctx.sessionManager.getEntries());
			if (turns.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "The session has no turns to distill yet.",
						},
					],
					details: { action: "draft", count: 0 } satisfies CaptureDetails,
				};
			}

			const transcript = condenseTranscript(turns);
			const completion = await runSideCompletion(ctx.modelRegistry, {
				systemPrompt: distillSystemPrompt(),
				prompt: distillUserPrompt(transcript, params.focus),
				current: ctx.model,
				signal,
			});
			if (!completion.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Could not distill rules: ${completion.error ?? "unknown error"}`,
						},
					],
					details: { action: "draft", count: 0 } satisfies CaptureDetails,
				};
			}

			const drafted = parseRules(completion.text);
			const body = drafted.length
				? "Drafted rules (not filed yet). Review with the user, refine by " +
					"talking, then call capture_lesson with the approved `rules`:\n" +
					drafted.map((r) => `- ${r}`).join("\n")
				: "No lesson worth capturing was found in this session.";
			return {
				content: [{ type: "text" as const, text: body }],
				details: {
					action: "draft",
					count: drafted.length,
				} satisfies CaptureDetails,
			};
		},
	});
}
