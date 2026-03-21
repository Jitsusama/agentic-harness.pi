/**
 * PR Review Extension
 *
 * Mode for reviewing someone else's pull request. The LLM drives
 * the workflow by calling pr_review with different actions:
 *
 *   activate          : parse PR ref, resolve repo, crawl context
 *   generate-comments : agent provides analysis and structured comments
 *   overview          : show Phase 1 overview panel
 *   review            : show Phase 2 review panel
 *   add-comment       : add a review comment
 *   update-comment    : edit an existing comment by ID
 *   remove-comment    : delete a comment by ID
 *   submit            : show final review summary panel
 *   post              : submit review to GitHub
 *   deactivate        : clean up and exit
 *
 * Handlers live in handlers.ts. This file is registration and
 * wiring only.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type CommentInput,
	type HandlerDeps,
	handleActivate,
	handleAddComment,
	handleDeactivate,
	handleGenerateComments,
	handleOverview,
	handlePost,
	handleRemoveComment,
	handleReview,
	handleSubmit,
	handleUpdateComment,
	type ReferenceSummaryInput,
	type SourceRoleInput,
} from "./handlers.js";
import { deactivate, restore } from "./lifecycle.js";
import { createState } from "./state.js";
import { buildPRReviewContext, prReviewContextFilter } from "./transitions.js";

/** Actions the LLM can request. */
const ACTIONS = [
	"activate",
	"generate-comments",
	"overview",
	"review",
	"add-comment",
	"update-comment",
	"remove-comment",
	"submit",
	"post",
	"deactivate",
] as const;

export default function prReview(pi: ExtensionAPI) {
	const state = createState();
	const deps: HandlerDeps = { state, pi };

	pi.registerTool({
		name: "pr_review",
		label: "PR Review",
		description:
			"Review someone else's pull request. Gathers deep context from the PR, " +
			"linked issues, and codebase, then guides a structured review with " +
			"AI-generated comments and a polished submit flow. " +
			"Call with 'activate' to start reviewing a PR.",
		promptSnippet:
			"Review a pull request. Read the pr-review skill for methodology.",
		promptGuidelines: [
			"Use when the user wants to review someone else's PR, do a code review, or provide PR feedback.",
			"Workflow: activate → generate-comments → overview → review → submit → post → deactivate.",
			"After activate, analyze the context and call 'generate-comments' with structured comments.",
			"Call 'overview' to show the Phase 1 overview panel.",
			"Call 'review' to show the Phase 2 review panel with file tabs.",
			"Use 'add-comment', 'update-comment', 'remove-comment' for comment management.",
			"Call 'submit' to show the final review summary, then 'post' to submit.",
			"When calling 'activate', include the user's original request in user_request so cross-repo handoffs preserve context.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"activate: start review | generate-comments: provide analysis and comments | " +
					"overview: show overview panel | review: show review panel | " +
					"add-comment: add a comment | update-comment: edit a comment | " +
					"remove-comment: delete a comment | " +
					"submit: show submit panel | post: submit review | deactivate: exit",
			}),
			pr: Type.Optional(
				Type.String({
					description:
						"PR reference (URL, #number, owner/repo#number). Only used with 'activate'.",
				}),
			),
			user_request: Type.Optional(
				Type.String({
					description:
						"The user's original request text. Included in the prompt when " +
						"the review is handed off to a new terminal tab for a cross-repo PR. " +
						"Only used with 'activate'.",
				}),
			),
			synopsis: Type.Optional(
				Type.String({
					description:
						"AI-generated PR synopsis. Used with 'generate-comments'.",
				}),
			),
			scope_analysis: Type.Optional(
				Type.String({
					description:
						"AI-generated scope analysis. Used with 'generate-comments'.",
				}),
			),
			source_roles: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "File path" }),
						role: Type.String({ description: "Why this file is relevant" }),
					}),
					{
						description:
							"Source file role descriptions. Used with 'generate-comments'.",
					},
				),
			),
			reference_summaries: Type.Optional(
				Type.Array(
					Type.Object({
						url: Type.String({ description: "Reference URL" }),
						summary: Type.String({
							description: "One-sentence AI summary of this reference",
						}),
					}),
					{
						description: "Reference summaries. Used with 'generate-comments'.",
					},
				),
			),
			comments: Type.Optional(
				Type.Array(
					Type.Object({
						file: Type.Union([Type.String(), Type.Null()], {
							description: "File path, or null for PR-level comment",
						}),
						startLine: Type.Union([Type.Number(), Type.Null()], {
							description: "Start line number, or null for file-level",
						}),
						endLine: Type.Union([Type.Number(), Type.Null()], {
							description: "End line number, or null for file-level",
						}),
						label: Type.String({
							description: "Conventional comment label",
						}),
						decorations: Type.Array(Type.String(), {
							description: "Comment decorations",
						}),
						subject: Type.String({ description: "Comment subject line" }),
						discussion: Type.String({
							description: "Comment discussion body",
						}),
						category: StringEnum(["file", "title", "scope"], {
							description: "Which tab the comment belongs to",
						}),
					}),
					{
						description: "Structured comments. Used with 'generate-comments'.",
					},
				),
			),
			comment: Type.Optional(
				Type.Object(
					{
						file: Type.Union([Type.String(), Type.Null()], {
							description: "File path, or null for PR-level comment",
						}),
						startLine: Type.Union([Type.Number(), Type.Null()], {
							description: "Start line number",
						}),
						endLine: Type.Union([Type.Number(), Type.Null()], {
							description: "End line number",
						}),
						label: Type.String({
							description: "Conventional comment label",
						}),
						decorations: Type.Array(Type.String(), {
							description: "Comment decorations",
						}),
						subject: Type.String({ description: "Comment subject line" }),
						discussion: Type.String({
							description: "Comment discussion body",
						}),
						category: StringEnum(["file", "title", "scope"], {
							description: "Which tab the comment belongs to",
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
			review_body: Type.Optional(
				Type.String({
					description: "Review body text. Used with 'submit'.",
				}),
			),
			verdict: Type.Optional(
				Type.String({
					description:
						"Review verdict (APPROVE, REQUEST_CHANGES, COMMENT). Used with 'submit'.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const comment = params.comment as CommentInput | undefined;
			const comments = params.comments as CommentInput[] | undefined;
			const sourceRoles = params.source_roles as SourceRoleInput[] | undefined;
			const refSummaries = params.reference_summaries as
				| ReferenceSummaryInput[]
				| undefined;

			switch (params.action) {
				case "activate":
					return handleActivate(
						deps,
						ctx,
						params.pr ?? null,
						(params.user_request as string) ?? null,
					);
				case "generate-comments":
					return handleGenerateComments(
						deps,
						(params.synopsis as string) ?? null,
						(params.scope_analysis as string) ?? null,
						sourceRoles ?? null,
						refSummaries ?? null,
						comments ?? null,
					);
				case "overview":
					return handleOverview(deps, ctx);
				case "review":
					return handleReview(deps, ctx);
				case "add-comment":
					return handleAddComment(deps, comment);
				case "update-comment":
					return handleUpdateComment(deps, params.comment_id ?? null, comment);
				case "remove-comment":
					return handleRemoveComment(deps, params.comment_id ?? null);
				case "submit":
					return handleSubmit(
						deps,
						ctx,
						(params.review_body as string) ?? null,
						(params.verdict as string) ?? null,
					);
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
			const d = res.details as Record<string, unknown> | undefined;
			const action = d?.action as string | undefined;

			if (action === "activate") {
				const files = d?.fileCount ?? 0;
				const refs = d?.referenceCount ?? 0;
				const reviewers = d?.reviewerCount ?? 0;
				return new Text(
					theme.fg(
						"success",
						`✓ ${files} files, ${refs} references, ${reviewers} reviewers`,
					),
					0,
					0,
				);
			}
			if (action === "generate-comments") {
				const count = d?.commentCount ?? 0;
				return new Text(
					theme.fg("success", `✓ ${count} comments generated`),
					0,
					0,
				);
			}
			if (action === "overview") {
				const redirected = d?.redirected ? " (redirected)" : "";
				return new Text(theme.fg("muted", `Overview panel${redirected}`), 0, 0);
			}
			if (action === "review") {
				const redirected = d?.redirected ? " (redirected)" : "";
				return new Text(theme.fg("muted", `Review panel${redirected}`), 0, 0);
			}
			if (action === "submit") {
				const redirected = d?.redirected ? " (redirected)" : "";
				return new Text(theme.fg("muted", `Submit panel${redirected}`), 0, 0);
			}
			if (action === "posted") {
				const comments = d?.comments ?? 0;
				const verdict = d?.verdict ?? "COMMENT";
				return new Text(
					theme.fg(
						"success",
						`✓ Review posted (${verdict}, ${comments} comments)`,
					),
					0,
					0,
				);
			}
			if (action === "deactivated") {
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

	pi.on("before_agent_start", async () => {
		return buildPRReviewContext(state);
	});

	pi.on("context", prReviewContextFilter(state));

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});
}
