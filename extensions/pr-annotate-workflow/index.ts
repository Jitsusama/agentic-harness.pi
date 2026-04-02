/**
 * PR Annotate Workflow Extension
 *
 * Session-based tool for proposing self-review comments on a
 * PR. The LLM drives the workflow through actions:
 *
 *   activate       : start annotation session for a PR
 *   add-comments   : propose comments (batch)
 *   add-comment    : add a single comment
 *   update-comment : edit a comment by ID
 *   remove-comment : remove comment(s) by ID
 *   list-comments  : list all comments with IDs and statuses
 *   review         : show the vetting workspace
 *   post           : submit review to GitHub
 *   deactivate     : exit annotation mode
 *
 * Comments live on the session and persist through redirects.
 * No more preApproved round-trips: the extension owns the
 * comment state across tool calls.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { fetchDiff, parseDiff } from "../../lib/internal/github/diff.js";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import { getCurrentRepo } from "../../lib/internal/github/repo-discovery.js";
import {
	activate,
	deactivate,
	ensureDiffFiles,
	persist,
	refreshUI,
	restore,
} from "./lifecycle.js";
import { postReview } from "./post.js";
import { showAnnotateWorkspace } from "./review.js";
import {
	addComment,
	commentStats,
	createSession,
	createState,
	findComment,
	formatCommentSummary,
	removeComment,
	removeComments,
	updateComment,
} from "./state.js";
import {
	injectAnnotateGuidance,
	pruneStaleAnnotateGuidance,
} from "./transitions.js";
import type { AnnotateComment, PRAnnotateState } from "./types.js";

/** Actions the LLM can request. */
const ACTIONS = [
	"activate",
	"add-comments",
	"add-comment",
	"update-comment",
	"remove-comment",
	"list-comments",
	"review",
	"post",
	"deactivate",
] as const;

const CommentSchema = Type.Object({
	path: Type.String({ description: "File path relative to repo root" }),
	line: Type.Number({
		description: "End line number in the diff to comment on",
	}),
	startLine: Type.Optional(
		Type.Number({
			description: "Start line number for a multi-line comment range",
		}),
	),
	subject: Type.Optional(
		Type.String({
			description:
				"Concise summary of the comment's concern (e.g., 'missing null check'). " +
				"Shown as the list label; the body is shown when expanded.",
		}),
	),
	body: Type.String({ description: "The review comment text" }),
	rationale: Type.String({
		description: "Why this is worth flagging (shown to user only, not posted)",
	}),
	side: Type.Optional(
		Type.String({
			description: "Side of the diff: LEFT or RIGHT (default: RIGHT)",
		}),
	),
});

/** Fetch and parse the PR diff for workspace context. */
async function fetchPRDiff(pi: ExtensionAPI, pr: number, repo?: string | null) {
	try {
		let ref: PRReference;
		if (repo) {
			const parts = repo.split("/");
			ref = { owner: parts[0] ?? "", repo: parts[1] ?? "", number: pr };
		} else {
			const current = await getCurrentRepo(pi);
			if (!current) return [];
			ref = { owner: current.owner, repo: current.repo, number: pr };
		}

		const diff = await fetchDiff(pi, ref);
		return parseDiff(diff);
	} catch {
		/* Diff fetch failed: workspace will show without diff context */
		return [];
	}
}

/** Build a plain text tool result. */
function plainTextResponse(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

export default function prAnnotate(pi: ExtensionAPI) {
	const state: PRAnnotateState = createState();

	pi.registerTool({
		name: "pr_annotate",
		label: "PR Annotate",
		description:
			"Propose self-review comments on a pull request for the user to vet before posting. " +
			"Session-based: activate first, then add comments and show the review workspace. " +
			"Call with 'activate' to start an annotation session.",
		promptGuidelines: [
			"Call `pr_annotate` after creating a PR to propose self-review comments.",
			"Workflow: activate → add-comments → review → post → deactivate.",
			"Focus on: design decisions worth explaining, assumptions that need validation, " +
				"scope boundaries reviewers should weigh in on, and deviations from the original plan.",
			"Do NOT flag: style issues, obvious code, or things the diff already makes clear.",
			"The rationale field is for the user only: explain why you think this is worth flagging.",
			"It is fine to pass an empty comments array if nothing warrants attention: the user can still add their own.",
			"Be concise in your review comment body: explain why you think this is worth flagging.",
			"Always provide a subject: a short phrase summarizing the concern (e.g., 'missing null check', " +
				"'design decision: fallback chain'). This appears as the list label during vetting.",
			"The line range is the most important part of a review comment: it frames what the reviewer " +
				"sees before they read a word. Read your comment body, identify the specific code it " +
				"discusses and select exactly those lines.",
			"Scope the range tightly: a naming concern → single declaration line; a logic concern → the " +
				"conditional block; a design decision → the function or type embodying it.",
			"Use a single line (no startLine) only when the comment is about one line. " +
				"For anything structural, use startLine + line to show the full relevant construct.",
			"When the user steers a comment during review, use 'update-comment' to revise it, " +
				"then call 'review' again. All comments persist through redirects.",
			"Use 'add-comment', 'update-comment', 'remove-comment' for individual comment management.",
			"Use 'list-comments' to see all comments with their IDs and statuses.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"activate: start session | add-comments: propose comments (batch) | " +
					"add-comment: add one comment | update-comment: edit by ID | " +
					"remove-comment: delete by ID | list-comments: show all with IDs | " +
					"review: show vetting workspace | post: submit to GitHub | " +
					"deactivate: exit",
			}),
			pr: Type.Optional(
				Type.Number({
					description: "Pull request number. Used with 'activate'.",
				}),
			),
			repo: Type.Optional(
				Type.String({
					description:
						"Repository in owner/repo format. Defaults to current repo.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description:
						"Summary body for the review. Used with 'activate' or 'post'.",
				}),
			),
			comments: Type.Optional(
				Type.Array(CommentSchema, {
					description: "Batch of comments to add. Used with 'add-comments'.",
				}),
			),
			comment: Type.Optional(CommentSchema),
			comment_id: Type.Optional(
				Type.String({
					description:
						"Comment ID. Used with 'update-comment' and 'remove-comment'.",
				}),
			),
			comment_ids: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Multiple comment IDs for bulk removal. Used with 'remove-comment'.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "activate":
					return handleActivate(state, pi, ctx, params);

				case "add-comments":
					return handleAddComments(state, pi, params);

				case "add-comment":
					return handleAddComment(state, pi, params);

				case "update-comment":
					return handleUpdateComment(state, pi, params);

				case "remove-comment":
					return handleRemoveComment(state, pi, params);

				case "list-comments":
					return handleListComments(state);

				case "review":
					return handleReview(state, pi, ctx);

				case "post":
					return handlePost(state, pi, params);

				case "deactivate":
					return handleDeactivate(state, pi, ctx);

				default:
					return plainTextResponse(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme) {
			const a = args as { action?: string; pr?: number };
			let text = theme.fg("toolTitle", theme.bold("pr_annotate "));
			text += theme.fg("muted", a.action ?? "?");
			if (a.pr) {
				text += theme.fg("dim", ` PR #${a.pr}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(res, _options, theme) {
			const d = res.details as Record<string, unknown> | undefined;
			if (!d) {
				const t = res.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}

			const action = d.action as string | undefined;

			if (d.error) {
				return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			}
			if (d.cancelled) {
				return new Text(theme.fg("warning", "Review cancelled"), 0, 0);
			}
			if (action === "activate") {
				const files = d.fileCount as number | undefined;
				const filePart = files ? `, ${files} files` : "";
				return new Text(
					theme.fg("success", `✓ Session started${filePart}`),
					0,
					0,
				);
			}
			if (action === "add-comments" || action === "add-comment") {
				const added = d.added as number | undefined;
				const total = d.total as number;
				const addedPart = added ? `${added} added, ` : "";
				return new Text(
					theme.fg("success", `✓ ${addedPart}${total} total`),
					0,
					0,
				);
			}
			if (action === "review") {
				const redirected = d.redirected ? " (redirected)" : "";
				return new Text(theme.fg("muted", `Review panel${redirected}`), 0, 0);
			}
			if (action === "posted") {
				const count = d.posted as number;
				return new Text(
					theme.fg(
						"success",
						`✓ ${count} comment${count !== 1 ? "s" : ""} posted`,
					),
					0,
					0,
				);
			}
			if (action === "deactivated") {
				return new Text(theme.fg("muted", "Annotate complete"), 0, 0);
			}

			const t = res.content?.[0];
			const text = t && "text" in t ? t.text : "";
			const maxLen = 80;
			const truncated =
				text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
			return new Text(theme.fg("muted", truncated), 0, 0);
		},
	});

	pi.on("before_agent_start", async () => {
		return injectAnnotateGuidance(state);
	});

	pi.on("context", pruneStaleAnnotateGuidance(state));

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});
}

// ── Action Handlers ──────────────────────────────────────

interface ToolParams {
	pr?: number;
	repo?: string;
	body?: string;
	comments?: Array<{
		path: string;
		line: number;
		startLine?: number;
		subject?: string;
		body: string;
		rationale: string;
		side?: string;
	}>;
	comment?: {
		path: string;
		line: number;
		startLine?: number;
		subject?: string;
		body: string;
		rationale: string;
		side?: string;
	};
	comment_id?: string;
	comment_ids?: string[];
}

async function handleActivate(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
	params: ToolParams,
) {
	if (state.enabled) {
		return plainTextResponse(
			`Annotation session is already active for PR #${state.session?.pr}. ` +
				"Call 'deactivate' first to start a new session.",
		);
	}

	if (!params.pr) {
		return plainTextResponse("Provide a PR number to annotate.");
	}

	const session = createSession(params.pr, params.repo ?? null);
	if (params.body) session.reviewBody = params.body;

	// We fetch the diff for workspace context.
	ctx.ui.notify(`Fetching diff for PR #${params.pr}…`, "info");
	session.diffFiles = await fetchPRDiff(pi, params.pr, params.repo);

	state.session = session;
	activate(state, pi, ctx);
	persist(state, pi);

	return {
		content: [
			{
				type: "text" as const,
				text:
					`Annotation session started for PR #${params.pr}. ` +
					`${session.diffFiles.length} files in diff.\n\n` +
					"Call 'add-comments' with your proposed comments, " +
					"then 'review' to show the vetting workspace.",
			},
		],
		details: {
			action: "activate",
			pr: params.pr,
			fileCount: session.diffFiles.length,
		},
	};
}

function handleAddComments(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	params: ToolParams,
) {
	if (!state.session) {
		return plainTextResponse(
			"No annotation session active. Call 'activate' first.",
		);
	}

	if (!params.comments || params.comments.length === 0) {
		return plainTextResponse(
			"Provide a comments array with at least one comment.",
		);
	}

	for (const c of params.comments) {
		addComment(state.session, {
			path: c.path,
			line: c.line,
			startLine: c.startLine,
			subject: c.subject,
			body: c.body,
			rationale: c.rationale,
			side: c.side || "RIGHT",
		});
	}

	persist(state, pi);

	const total = state.session.comments.length;
	return {
		content: [
			{
				type: "text" as const,
				text:
					`Added ${params.comments.length} comment${params.comments.length !== 1 ? "s" : ""}. ` +
					`Total: ${total}. Call 'review' to show the vetting workspace.`,
			},
		],
		details: {
			action: "add-comments",
			added: params.comments.length,
			total,
		},
	};
}

function handleAddComment(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	params: ToolParams,
) {
	if (!state.session) {
		return plainTextResponse(
			"No annotation session active. Call 'activate' first.",
		);
	}

	if (!params.comment) {
		return plainTextResponse(
			"Provide a comment object with: path, line, body, rationale.",
		);
	}

	const c = params.comment;
	const comment = addComment(state.session, {
		path: c.path,
		line: c.line,
		startLine: c.startLine,
		subject: c.subject,
		body: c.body,
		rationale: c.rationale,
		side: c.side || "RIGHT",
	});

	persist(state, pi);

	return {
		content: [
			{
				type: "text" as const,
				text:
					`Comment added: ${formatCommentSummary(comment)}\n` +
					`Total: ${state.session.comments.length}.`,
			},
		],
		details: {
			action: "add-comment",
			commentId: comment.id,
			total: state.session.comments.length,
		},
	};
}

function handleUpdateComment(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	params: ToolParams,
) {
	if (!state.session) {
		return plainTextResponse("No annotation session active.");
	}

	if (!params.comment_id) {
		return plainTextResponse(
			"Provide comment_id to identify which comment to update.",
		);
	}

	if (!params.comment) {
		return plainTextResponse(
			"Provide a comment object with the updated fields.",
		);
	}

	const updates: Partial<Omit<AnnotateComment, "id">> = {};
	const c = params.comment;
	if (c.path) updates.path = c.path;
	if (c.line) updates.line = c.line;
	if (c.startLine !== undefined) updates.startLine = c.startLine;
	if (c.subject !== undefined) updates.subject = c.subject;
	if (c.body) updates.body = c.body;
	if (c.rationale) updates.rationale = c.rationale;
	if (c.side) updates.side = c.side;

	const found = updateComment(state.session, params.comment_id, updates);
	if (!found) {
		return plainTextResponse(`Comment ${params.comment_id} not found.`);
	}

	persist(state, pi);

	return {
		content: [
			{
				type: "text" as const,
				text: `Comment ${params.comment_id} updated.`,
			},
		],
		details: { action: "update-comment", commentId: params.comment_id },
	};
}

function handleRemoveComment(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	params: ToolParams,
) {
	if (!state.session) {
		return plainTextResponse("No annotation session active.");
	}

	// Bulk removal.
	if (params.comment_ids && params.comment_ids.length > 0) {
		const result = removeComments(state.session, params.comment_ids);
		persist(state, pi);

		const parts: string[] = [];
		if (result.removed.length > 0) {
			parts.push(
				`Removed ${result.removed.length} comment${result.removed.length !== 1 ? "s" : ""}: ${result.removed.join(", ")}.`,
			);
		}
		if (result.notFound.length > 0) {
			parts.push(`Not found: ${result.notFound.join(", ")}.`);
		}
		parts.push(`Total: ${state.session.comments.length}.`);

		return {
			content: [{ type: "text" as const, text: parts.join(" ") }],
			details: {
				action: "remove-comment",
				removed: result.removed,
				notFound: result.notFound,
			},
		};
	}

	// Single removal.
	if (!params.comment_id) {
		return plainTextResponse(
			"Provide comment_id or comment_ids to identify which comments to remove.",
		);
	}

	const found = removeComment(state.session, params.comment_id);
	if (!found) {
		return plainTextResponse(`Comment ${params.comment_id} not found.`);
	}

	persist(state, pi);

	return {
		content: [
			{
				type: "text" as const,
				text: `Comment ${params.comment_id} removed. Total: ${state.session.comments.length}.`,
			},
		],
		details: { action: "remove-comment", commentId: params.comment_id },
	};
}

function handleListComments(state: PRAnnotateState) {
	if (!state.session) {
		return plainTextResponse("No annotation session active.");
	}

	const { comments } = state.session;
	if (comments.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No comments." }],
			details: { action: "list-comments", count: 0 },
		};
	}

	const lines = comments.map((c) => `- ${formatCommentSummary(c)}`);
	return {
		content: [
			{
				type: "text" as const,
				text: `${comments.length} comments:\n${lines.join("\n")}`,
			},
		],
		details: { action: "list-comments", count: comments.length },
	};
}

async function handleReview(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
) {
	if (!state.session) {
		return plainTextResponse(
			"No annotation session active. Call 'activate' first.",
		);
	}

	// We ensure diff files are available (re-fetch if restored from persistence).
	const session = state.session;
	await ensureDiffFiles(state, () => fetchPRDiff(pi, session.pr, session.repo));

	refreshUI(state, ctx);

	const result = await showAnnotateWorkspace(ctx, state.session);

	persist(state, pi);
	refreshUI(state, ctx);

	if (!result) {
		return plainTextResponse(
			"Review workspace dismissed. Call 'review' to reopen, " +
				"or 'post' to submit.",
		);
	}

	if (result.action === "submit") {
		return plainTextResponse(
			"User submitted from review workspace. Call 'post' to submit the review.",
		);
	}

	if (result.action === "redirect") {
		const parts: string[] = [];
		parts.push(`User feedback from review workspace:\n\n"${result.note}"`);

		if (result.commentId) {
			const comment = findComment(state.session, result.commentId);
			if (comment) {
				const lineRange = comment.startLine
					? `L${comment.startLine}-${comment.line}`
					: `L${comment.line}`;
				parts.push("");
				parts.push("Comment being redirected:");
				parts.push(`- ID: ${comment.id}`);
				parts.push(`- File: ${comment.path}`);
				parts.push(`- Lines: ${lineRange}`);
				parts.push(`- Body: ${comment.body}`);
				if (comment.rationale) parts.push(`- Rationale: ${comment.rationale}`);
				parts.push("");
				parts.push(
					"Use 'update-comment' with this comment_id to revise it, " +
						"then call 'review' to re-open the workspace.",
				);
			}
		} else {
			parts.push(
				"\n\nProcess the feedback and call 'review' to re-open the workspace.",
			);
		}

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "review", redirected: true },
		};
	}

	return plainTextResponse("Review complete.");
}

async function handlePost(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	params: ToolParams,
) {
	if (!state.session) {
		return plainTextResponse("No annotation session active.");
	}

	const session = state.session;
	const stats = commentStats(session);

	if (stats.pending > 0) {
		return plainTextResponse(
			`${stats.pending} comment${stats.pending !== 1 ? "s are" : " is"} still pending. ` +
				"Call 'review' to vet all comments before posting.",
		);
	}

	const approved = session.comments.filter((c) => c.status === "approved");

	if (approved.length === 0) {
		return plainTextResponse("No comments approved for posting.");
	}

	if (params.body) session.reviewBody = params.body;

	const postResult = await postReview(
		pi,
		session.pr,
		approved,
		session.reviewBody,
		session.repo ?? undefined,
	);

	if (postResult.error) {
		return {
			content: [
				{
					type: "text" as const,
					text:
						`Failed to post review: ${postResult.error}\n\n` +
						`${approved.length} approved comment${approved.length !== 1 ? "s" : ""} were not posted. ` +
						"Fix the issue and call 'post' again.",
				},
			],
			details: {
				action: "post",
				posted: 0,
				error: postResult.error,
			},
		};
	}

	return {
		content: [
			{
				type: "text" as const,
				text:
					`Posted ${approved.length} review comment${approved.length !== 1 ? "s" : ""} on PR #${session.pr}. ` +
					`${stats.rejected} rejected. Call 'deactivate' to exit.`,
			},
		],
		details: {
			action: "posted",
			posted: approved.length,
			rejected: stats.rejected,
		},
	};
}

function handleDeactivate(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
) {
	if (!state.enabled) {
		return plainTextResponse("Annotation mode is not active.");
	}

	const commentCount = state.session?.comments.length ?? 0;
	const prNum = state.session?.pr;

	deactivate(state, pi, ctx);

	return {
		content: [
			{
				type: "text" as const,
				text: `Annotation session for PR #${prNum} complete. ${commentCount} comments collected.`,
			},
		],
		details: { action: "deactivated" },
	};
}
