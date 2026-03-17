/**
 * PR Reply Extension
 *
 * Mode for responding to GitHub PR review feedback. The LLM
 * drives the workflow by calling pr_reply with different actions:
 *
 *   activate   — load PR, show summary, enter mode
 *   next       — present the next pending thread
 *   review     — show review overview with analysis
 *   show       — present thread gate with recommendation
 *   implement  — mark current thread for implementation
 *   reply      — draft and post a reply to the current thread
 *   done       — mark implementation complete, link commits
 *   skip       — skip the current thread
 *   defer      — defer the current thread
 *   deactivate — exit PR reply mode
 *
 * Handlers live in handlers.ts. This file is registration and
 * wiring only.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	handleActivate,
	handleDeactivate,
	handleDefer,
	handleDone,
	handleImplement,
	handleNext,
	handleReplyAction,
	handleReview,
	handleShow,
	handleSkip,
} from "./handlers.js";
import {
	collectImplementationCommits,
	handleTDDCompletion,
	linkCommitsToThread,
} from "./implementation.js";
import { persist, restore, toggle } from "./lifecycle.js";
import { createPRReplyState } from "./state.js";
import { buildPRReplyContext, prReplyContextFilter } from "./transitions.js";

/** Actions the LLM can request. */
const ACTIONS = [
	"activate",
	"deactivate",
	"next",
	"review",
	"show",
	"implement",
	"reply",
	"done",
	"skip",
	"defer",
] as const;

export default function prReply(pi: ExtensionAPI) {
	const state = createPRReplyState();

	// ---- Tool ----

	pi.registerTool({
		name: "pr_reply",
		label: "PR Reply",
		description:
			"Manage PR reply mode — respond to review feedback on a pull request. " +
			"Call with 'activate' to start, then 'next' to iterate threads. " +
			"For each thread, choose 'implement', 'reply', 'skip', or 'defer'. " +
			"After implementing changes, call 'done' to link commits and post a reply.",
		promptSnippet:
			"Respond to PR review feedback. " +
			"Read the pr-reply skill for methodology.",
		promptGuidelines: [
			"Use when the user wants to respond to PR reviews, address review feedback, or handle PR comments.",
			"Workflow: activate → next → review → next → show → (action) → next → ... → deactivate.",
			"'next' returns either a review summary (new reviewer) or thread data (same reviewer).",
			"When you get a review summary: analyze the review's character, then call 'review' with your analysis.",
			"When you get thread data: analyze the thread, then call 'show' with your recommendation.",
			"After the user approves 'implement': make changes, run tests, commit. Then call 'done' with a reply_body.",
			"After the user approves 'reply': call 'reply' with the reply_body text.",
			"The reply_body should be conversational, acknowledge feedback, and include commit SHAs inline if changes were made.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"activate: start mode | next: load next thread or review | " +
					"review: show review overview with analysis | " +
					"show: present thread gate with recommendation | " +
					"implement: begin implementing current thread | " +
					"reply: post a reply | done: finish implementation | " +
					"skip: skip thread | defer: defer thread | deactivate: exit mode",
			}),
			pr: Type.Optional(
				Type.String({
					description:
						"PR reference (URL, #number, owner/repo#number). Only used with 'activate'.",
				}),
			),
			analysis: Type.Optional(
				Type.String({
					description:
						"Your analysis text. For 'review': overall review character. " +
						"For 'show': thread recommendation. Supports markdown.",
				}),
			),
			reply_body: Type.Optional(
				Type.String({
					description:
						"Reply text to post. Used with 'reply' and 'done' actions.",
				}),
			),
			use_tdd: Type.Optional(
				Type.Boolean({
					description:
						"Whether to use TDD mode for implementation. Used with 'implement'.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "activate":
					return handleActivate(state, pi, ctx, params.pr ?? null);
				case "deactivate":
					return handleDeactivate(state, pi, ctx);
				case "next":
					return handleNext(state, pi, ctx);
				case "review":
					return handleReview(state, pi, ctx, params.analysis ?? "");
				case "show":
					return handleShow(state, pi, ctx, params.analysis ?? "");
				case "implement":
					return handleImplement(state, pi, params.use_tdd);
				case "reply":
					return handleReplyAction(state, pi, ctx, params.reply_body ?? null);
				case "done":
					return handleDone(state, pi, ctx, params.reply_body ?? null);
				case "skip":
					return handleSkip(state, pi);
				case "defer":
					return handleDefer(state, pi);
				default:
					return {
						content: [
							{
								type: "text" as const,
								text: `Unknown action: ${params.action}`,
							},
						],
					};
			}
		},

		renderCall(args, theme) {
			const a = args as { action?: string; pr?: string };
			let text = theme.fg("toolTitle", theme.bold("pr_reply "));
			text += theme.fg("muted", a.action ?? "?");
			if (a.pr) {
				text += theme.fg("dim", ` ${a.pr}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(res, _options, theme) {
			const d = res.details as
				| { action?: string; threadCount?: number; openedTab?: boolean }
				| undefined;
			if (d?.openedTab) {
				return new Text(
					theme.fg("success", "↗ Opened new tab — this session is done"),
					0,
					0,
				);
			}
			if (d?.action === "activate" && d.threadCount) {
				return new Text(
					theme.fg("success", `✓ ${d.threadCount} threads loaded`),
					0,
					0,
				);
			}
			if (d?.action === "next") {
				return new Text(theme.fg("muted", "Thread loaded"), 0, 0);
			}
			if (d?.action === "replied") {
				return new Text(theme.fg("success", "✓ Reply posted"), 0, 0);
			}
			const t = res.content?.[0];
			const text = t && "text" in t ? t.text : "";
			const maxLen = 80;
			const truncated =
				text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
			return new Text(theme.fg("muted", truncated), 0, 0);
		},
	});

	// ---- Commands ----

	pi.registerCommand("pr-reply", {
		description: "Toggle PR reply mode",
		handler: async (_args, ctx) => toggle(state, pi, ctx),
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("r"), {
		description: "Toggle PR reply mode",
		handler: async (ctx) => toggle(state, pi, ctx),
	});

	// ---- TDD coordination ----

	pi.on("tool_result", async (event) => {
		if (!state.enabled || !state.awaitingTDDCompletion) return;
		if (event.toolName !== "tdd_phase") return;

		const details = event.details as { action?: string } | undefined;
		if (details?.action !== "done" && details?.action !== "stop") return;

		handleTDDCompletion(state);

		const commits = await collectImplementationCommits(state, pi);
		if (state.tddThreadId) {
			linkCommitsToThread(state, state.tddThreadId, commits);
		}

		persist(state, pi);
	});

	// ---- Context injection ----

	pi.on("before_agent_start", async () => {
		return buildPRReplyContext(state);
	});

	pi.on("context", prReplyContextFilter(state));

	// ---- Session restore ----

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});
}
