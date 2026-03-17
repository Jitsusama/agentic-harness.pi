/**
 * PR Review Extension
 *
 * Mode for reviewing someone else's pull request. The LLM drives
 * the workflow by calling pr_review with different actions:
 *
 *   activate       — parse PR ref, create worktree, gather context
 *   context        — show context summary (re-showable any time)
 *   description    — review PR description & scope
 *   analyze        — deep analysis context for LLM investigation
 *   review-files   — tabbed file review (diff/file/comments)
 *   add-comment    — add a review comment
 *   update-comment — edit an existing comment by ID
 *   remove-comment — delete a comment by ID
 *   resume         — return to current phase after conversation
 *   vet            — final vetting with post option
 *   post           — submit review to GitHub
 *   deactivate     — clean up and exit
 *
 * Handlers live in handlers.ts. This file is registration and
 * wiring only.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type CommentInput,
	type HandlerDeps,
	handleActivate,
	handleAddComment,
	handleAnalyze,
	handleContext,
	handleDeactivate,
	handleDescription,
	handlePost,
	handleRemoveComment,
	handleResume,
	handleReviewFiles,
	handleUpdateComment,
	handleVet,
} from "./handlers.js";
import { deactivate, restore } from "./lifecycle.js";
import { createState } from "./state.js";
import { buildPRReviewContext, prReviewContextFilter } from "./transitions.js";

/** Actions the LLM can request. */
const ACTIONS = [
	"activate",
	"context",
	"description",
	"analyze",
	"review-files",
	"add-comment",
	"update-comment",
	"remove-comment",
	"resume",
	"vet",
	"post",
	"deactivate",
] as const;

export default function prReview(pi: ExtensionAPI) {
	const state = createState();
	const deps: HandlerDeps = { state, pi };

	// ---- Tool ----

	pi.registerTool({
		name: "pr_review",
		label: "PR Review",
		description:
			"Review someone else's pull request. Gathers context from the PR, " +
			"linked issues, and codebase, then guides a structured review through " +
			"description evaluation, deep analysis, and file-by-file comment collection. " +
			"Call with 'activate' to start reviewing a PR.",
		promptSnippet:
			"Review a pull request. Read the pr-review skill for methodology.",
		promptGuidelines: [
			"Use when the user wants to review someone else's PR, do a code review, or provide PR feedback.",
			"Workflow: activate → context → description → analyze → review-files → vet → deactivate.",
			"After activate, call 'context' to show the gathered context summary.",
			"Call 'description' to review the PR title, description, and scope.",
			"Call 'analyze' to get context for deep analysis — then investigate the codebase yourself.",
			"Call 'review-files' for tabbed file review. The user navigates files freely.",
			"Use 'add-comment' to add review comments, 'update-comment' to edit, 'remove-comment' to delete.",
			"Call 'vet' to enter final vetting. The user can post directly from the vetting panel.",
			"The user can break out to conversation at any point. Call 'resume' to return.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"activate: start review | context: show context summary | " +
					"description: review PR description | analyze: deep analysis | " +
					"review-files: tabbed file review | " +
					"add-comment: add a comment | update-comment: edit a comment | " +
					"remove-comment: delete a comment | resume: return to current phase | " +
					"vet: final vetting | post: submit review | deactivate: exit",
			}),
			pr: Type.Optional(
				Type.String({
					description:
						"PR reference (URL, #number, owner/repo#number). Only used with 'activate'.",
				}),
			),
			comment: Type.Optional(
				Type.Object(
					{
						file: Type.String({ description: "File path" }),
						startLine: Type.Number({ description: "Start line number" }),
						endLine: Type.Number({ description: "End line number" }),
						label: Type.String({
							description: "Conventional comment label",
						}),
						decorations: Type.Array(Type.String(), {
							description: "Comment decorations (blocking, non-blocking, etc.)",
						}),
						subject: Type.String({ description: "Comment subject line" }),
						discussion: Type.String({
							description: "Comment discussion body",
						}),
					},
					{
						description:
							"Structured comment data. Used with 'add-comment' and 'update-comment'.",
					},
				),
			),
			comment_id: Type.Optional(
				Type.String({
					description:
						"Comment ID. Used with 'update-comment' and 'remove-comment'.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const comment = params.comment as CommentInput | undefined;

			switch (params.action) {
				case "activate":
					return handleActivate(deps, ctx, params.pr ?? null);
				case "context":
					return handleContext(deps, ctx);
				case "description":
					return handleDescription(deps, ctx);
				case "analyze":
					return handleAnalyze(deps, ctx);
				case "review-files":
					return handleReviewFiles(deps, ctx);
				case "add-comment":
					return handleAddComment(deps, comment);
				case "update-comment":
					return handleUpdateComment(deps, params.comment_id ?? null, comment);
				case "remove-comment":
					return handleRemoveComment(deps, params.comment_id ?? null);
				case "resume":
					return handleResume(deps, ctx);
				case "vet":
					return handleVet(deps, ctx);
				case "post":
					return handlePost(deps);
				case "deactivate":
					return handleDeactivate(deps, ctx);
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
			let text = theme.fg("toolTitle", theme.bold("pr_review "));
			text += theme.fg("muted", a.action ?? "?");
			if (a.pr) {
				text += theme.fg("dim", ` ${a.pr}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(res, _options, theme) {
			const d = res.details as
				| { action?: string; fileCount?: number }
				| undefined;
			if (d?.action === "activate" && d.fileCount) {
				return new Text(
					theme.fg("success", `✓ ${d.fileCount} files, context gathered`),
					0,
					0,
				);
			}
			if (d?.action === "posted") {
				return new Text(theme.fg("success", "✓ Review posted"), 0, 0);
			}
			if (d?.action === "deactivated") {
				return new Text(theme.fg("muted", "Review complete"), 0, 0);
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

	pi.registerCommand("pr-review", {
		description: "Toggle PR review mode",
		handler: async (_args, ctx) => {
			if (state.enabled) {
				deactivate(state, pi, ctx);
				ctx.ui.notify("PR review mode off.");
			} else {
				ctx.ui.notify(
					"PR review mode requires activation via the pr_review tool.",
					"warning",
				);
			}
		},
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("v"), {
		description: "Deactivate PR review mode",
		handler: async (ctx) => {
			if (state.enabled) {
				deactivate(state, pi, ctx);
				ctx.ui.notify("PR review mode off.");
			}
		},
	});

	// ---- Context injection ----

	pi.on("before_agent_start", async () => {
		return buildPRReviewContext(state);
	});

	pi.on("context", prReviewContextFilter(state));

	// ---- Session restore ----

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});
}
