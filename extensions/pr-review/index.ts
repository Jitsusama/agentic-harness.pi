/**
 * PR Review Extension
 *
 * Mode for reviewing someone else's pull request. The LLM drives
 * the workflow by calling pr_review with different actions:
 *
 *   activate     — parse PR ref, create worktree, gather context
 *   context      — show context summary (re-showable any time)
 *   description  — review PR description & scope
 *   analyze      — run deep analysis, return to conversation
 *   review-files — enter file-by-file review
 *   next-file    — advance to the next file
 *   add-comment  — add a review comment
 *   resume       — return to current phase after conversation
 *   vet          — enter final vetting phase
 *   post         — post the review to GitHub
 *   deactivate   — clean up and exit
 *
 * Each action returns structured context for the LLM to reason
 * about. The LLM reads it, presents findings, and calls back
 * with the next action.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { progress } from "../lib/ui/progress.js";
import {
	assembleContext,
	fetchDiff,
	fetchPRGraphQL,
	fetchPreviousReviews,
	fetchSiblingPRs,
	getCurrentUser,
	postReview,
} from "./api/github.js";
import type { PRReference } from "./api/parse.js";
import { extractOwnerRepo, parsePRReference } from "./api/parse.js";
import {
	briefActivation,
	briefAnalysis,
	briefContext,
	briefDescription,
	briefDescriptionSteer,
	briefFileReview,
	briefFileSteer,
} from "./briefing.js";
import {
	activate,
	deactivate,
	persist,
	refreshUI,
	restore,
} from "./lifecycle.js";
import {
	addComment,
	commentsByStatus,
	createSession,
	createState,
	type LinkedIssue,
	type ReviewSession,
	removeComment,
	updateComment,
} from "./state.js";
import { buildPRReviewContext, prReviewContextFilter } from "./transitions.js";
import { showContextSummary } from "./ui/context-summary.js";
import { showDescriptionReview } from "./ui/description.js";
import { showFileReview } from "./ui/file-review.js";
import { showVetting, type VettingResult } from "./ui/vetting.js";
import { createWorktree, isOnPRBranch, removeWorktree } from "./worktree.js";

/** Actions the LLM can request. */
const ACTIONS = [
	"activate",
	"context",
	"description",
	"analyze",
	"review-files",
	"next-file",
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
					"review-files: tabbed file review | next-file: (deprecated) | " +
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
			switch (params.action) {
				case "activate":
					return handleActivate(ctx, params.pr ?? null);
				case "context":
					return handleContext(ctx);
				case "description":
					return handleDescription(ctx);
				case "analyze":
					return handleAnalyze(ctx);
				case "review-files":
					return handleReviewFiles(ctx);
				case "next-file":
					return handleNextFile(ctx);
				case "add-comment":
					return handleAddComment(params.comment);
				case "update-comment":
					return handleUpdateComment(params.comment_id ?? null, params.comment);
				case "remove-comment":
					return handleRemoveComment(params.comment_id ?? null);
				case "resume":
					return handleResume(ctx);
				case "vet":
					return handleVet(ctx);
				case "post":
					return handlePost();
				case "deactivate":
					return handleDeactivate(ctx);
				default:
					return textResult(`Unknown action: ${params.action}`);
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

	// ---- Helpers ----

	/**
	 * Ensure gathered context is available. If the session was
	 * restored but context was lost (too large for appendEntry),
	 * re-fetch it from GitHub transparently.
	 */
	async function ensureContext(ctx: ExtensionContext): Promise<boolean> {
		const session = state.session;
		if (!session) return false;
		if (session.context) return true;

		const { pr } = session;
		const ref: PRReference = {
			owner: pr.owner,
			repo: pr.repo,
			number: pr.number,
		};

		ctx.ui.notify("Re-fetching PR context…", "info");

		try {
			const [graphqlData, diff] = await Promise.all([
				fetchPRGraphQL(pi, ref),
				fetchDiff(pi, ref),
			]);

			session.context = assembleContext(
				graphqlData.pr,
				diff,
				graphqlData.prComments,
				graphqlData.issues,
				[],
			);
			return true;
		} catch {
			/* Re-fetch failed — context unavailable */
			return false;
		}
	}

	/** Resolve a PR reference from user input. */
	async function resolvePR(
		prInput: string | null,
	): Promise<PRReference | null> {
		const currentRepo = await getCurrentRepo(pi);

		if (prInput) {
			return parsePRReference(prInput, currentRepo?.owner, currentRepo?.repo);
		}

		return null;
	}

	// ---- Action handlers ----

	async function handleActivate(ctx: ExtensionContext, prInput: string | null) {
		if (state.session) {
			return textResult(
				`PR review is already active for #${state.session.pr.number}. ` +
					"Call 'deactivate' first to start a new review.",
			);
		}

		const ref = await resolvePR(prInput);
		if (!ref) {
			return textResult(
				"Could not determine which PR to review. " +
					"Provide a PR URL, number (#123), or owner/repo#number.",
			);
		}

		state.phase = "gathering";
		state.enabled = true;
		activate(state, pi, ctx);

		// Shared state for tasks that depend on the GraphQL result.
		let fetchedIssues: LinkedIssue[] = [];
		let fetchedAuthor = "";
		let graphqlDone: () => void;
		const graphqlReady = new Promise<void>((resolve) => {
			graphqlDone = resolve;
		});

		const results = await progress(
			ctx,
			{ title: `Gathering context for PR #${ref.number}…` },
			[
				{
					label: "PR metadata & issues",
					run: async () => {
						const data = await fetchPRGraphQL(pi, ref);
						fetchedIssues = data.issues;
						fetchedAuthor = data.pr.author;
						graphqlDone();
						return data;
					},
				},
				{
					label: "Diff",
					run: async () => fetchDiff(pi, ref),
				},
				{
					label: "Sibling PRs",
					run: async () => {
						await graphqlReady;
						return fetchSiblingPRs(pi, ref, fetchedIssues);
					},
				},
				{
					label: "Previous reviews",
					run: async () => {
						try {
							await graphqlReady;
							const username = await getCurrentUser(pi);
							return fetchPreviousReviews(pi, ref, username, fetchedAuthor);
						} catch {
							/* Previous reviews unavailable — not fatal */
							return { reviews: [], threads: [] };
						}
					},
				},
			] as const,
		);

		if (!results) {
			deactivate(state, pi, ctx);
			return textResult("PR review cancelled.");
		}

		const [graphqlData, diff, siblingPRs, previousData] = results;

		if (!graphqlData || !diff) {
			deactivate(state, pi, ctx);
			return textResult(
				"Failed to gather PR context — metadata or diff unavailable.",
			);
		}

		const context = assembleContext(
			graphqlData.pr,
			diff,
			graphqlData.prComments,
			graphqlData.issues,
			siblingPRs ?? [],
		);

		const session = createSession(
			{
				owner: ref.owner,
				repo: ref.repo,
				number: ref.number,
				branch: context.pr.headRefName,
				baseBranch: context.pr.baseRefName,
				author: context.pr.author,
			},
			context,
		);

		if (previousData && previousData.reviews.length > 0) {
			session.previousReview = previousData;
		}

		const onBranch = await isOnPRBranch(pi, context.pr.headRefName);
		if (!onBranch) {
			try {
				session.worktreePath = await createWorktree(pi, ref.number);
				session.usingWorktree = true;
			} catch {
				/* Worktree creation failed — review without it */
			}
		}

		state.session = session;
		state.phase = "context";
		persist(state, pi);
		refreshUI(state, ctx);

		return {
			content: [{ type: "text" as const, text: briefActivation(session) }],
			details: {
				action: "activate",
				fileCount: context.diffFiles.length,
				issueCount: context.issues.length,
			},
		};
	}

	async function handleContext(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult("Failed to load PR context.");
		}

		const session = state.session;
		const context = session.context;
		if (!context) return textResult("Context unavailable.");

		await showContextSummary(ctx, context, session.worktreePath);

		return {
			content: [{ type: "text" as const, text: briefContext(context) }],
			details: { action: "context", phase: state.phase },
		};
	}

	async function handleDescription(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult("Failed to load PR context.");
		}

		state.phase = "description";
		const context = state.session.context;
		if (!context) return textResult("Context unavailable.");

		const panelResult = await showDescriptionReview(ctx, context);

		if (panelResult.action === "cancel") {
			return textResult(
				"Description review dismissed. Call 'description' to re-show, " +
					"or 'analyze' to proceed.",
			);
		}

		if (panelResult.action === "steer") {
			return {
				content: [
					{
						type: "text" as const,
						text: briefDescriptionSteer(context, panelResult.note),
					},
				],
				details: { action: "description", phase: "description", steered: true },
			};
		}

		return {
			content: [{ type: "text" as const, text: briefDescription(context) }],
			details: { action: "description", phase: "description" },
		};
	}

	async function handleAnalyze(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult("Failed to load PR context.");
		}

		state.phase = "analyzing";
		const session = state.session;
		const context = session.context;
		if (!context) return textResult("Context unavailable.");

		return {
			content: [
				{
					type: "text" as const,
					text: briefAnalysis(
						context,
						session.worktreePath ?? ".",
						session.previousReview,
					),
				},
			],
			details: { action: "analyze", phase: "analyzing" },
		};
	}

	async function handleReviewFiles(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult("Failed to load PR context.");
		}

		state.phase = "files";
		const session = state.session;
		const context = session.context;
		if (!context) return textResult("Context unavailable.");

		const panelResult = await showFileReview(
			ctx,
			context.diffFiles,
			session.comments,
			session.worktreePath,
		);

		refreshUI(state, ctx);

		if (panelResult.action === "cancel") {
			return textResult(
				"File review dismissed. Call 'review-files' to re-show, " +
					"or 'vet' to proceed to vetting.",
			);
		}

		if (panelResult.action === "steer") {
			return {
				content: [
					{
						type: "text" as const,
						text: briefFileSteer(
							panelResult.file,
							panelResult.note,
							session.worktreePath,
						),
					},
				],
				details: {
					action: "review-files",
					phase: "files",
					file: panelResult.file,
					steered: true,
				},
			};
		}

		return {
			content: [
				{
					type: "text" as const,
					text: briefFileReview(context.diffFiles, session.comments),
				},
			],
			details: {
				action: "review-files",
				phase: "files",
				fileCount: context.diffFiles.length,
			},
		};
	}

	async function handleNextFile(_ctx: ExtensionContext) {
		return textResult(
			"File navigation is now handled within the review-files panel. " +
				"Call 'review-files' to open the tabbed file review.",
		);
	}

	function handleAddComment(comment: unknown) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		if (!comment || typeof comment !== "object") {
			return textResult(
				"Provide a comment object with: file, startLine, endLine, " +
					"label, decorations, subject, discussion.",
			);
		}

		const c = comment as Record<string, unknown>;

		const reviewComment = addComment(state.session, {
			file: String(c.file ?? ""),
			startLine: Number(c.startLine ?? 0),
			endLine: Number(c.endLine ?? 0),
			label: String(c.label ?? "suggestion"),
			decorations: Array.isArray(c.decorations)
				? c.decorations.map(String)
				: [],
			subject: String(c.subject ?? ""),
			discussion: String(c.discussion ?? ""),
		});

		persist(state, pi);

		const decorStr =
			reviewComment.decorations.length > 0
				? ` (${reviewComment.decorations.join(", ")})`
				: "";

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Comment added: ${reviewComment.label}${decorStr} on ` +
						`${reviewComment.file}:${reviewComment.startLine}-${reviewComment.endLine}\n` +
						`Subject: ${reviewComment.subject}\n` +
						`Total: ${state.session.comments.length} comments.\n\n` +
						"Call pr_review with action 'resume' to return to file review.",
				},
			],
			details: {
				action: "add-comment",
				commentId: reviewComment.id,
				total: state.session.comments.length,
			},
		};
	}

	function handleUpdateComment(commentId: string | null, comment: unknown) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		if (!commentId) {
			return textResult(
				"Provide comment_id to identify which comment to update.",
			);
		}

		if (!comment || typeof comment !== "object") {
			return textResult("Provide a comment object with the updated fields.");
		}

		const c = comment as Record<string, unknown>;
		const updates: Record<string, unknown> = {};
		if (c.file != null) updates.file = String(c.file);
		if (c.startLine != null) updates.startLine = Number(c.startLine);
		if (c.endLine != null) updates.endLine = Number(c.endLine);
		if (c.label != null) updates.label = String(c.label);
		if (c.decorations != null && Array.isArray(c.decorations)) {
			updates.decorations = c.decorations.map(String);
		}
		if (c.subject != null) updates.subject = String(c.subject);
		if (c.discussion != null) updates.discussion = String(c.discussion);

		const found = updateComment(state.session, commentId, updates);
		if (!found) {
			return textResult(`Comment ${commentId} not found.`);
		}

		persist(state, pi);

		return {
			content: [
				{
					type: "text" as const,
					text: `Comment ${commentId} updated. Total: ${state.session.comments.length}.`,
				},
			],
			details: { action: "update-comment", commentId },
		};
	}

	function handleRemoveComment(commentId: string | null) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		if (!commentId) {
			return textResult(
				"Provide comment_id to identify which comment to remove.",
			);
		}

		const found = removeComment(state.session, commentId);
		if (!found) {
			return textResult(`Comment ${commentId} not found.`);
		}

		persist(state, pi);

		return {
			content: [
				{
					type: "text" as const,
					text: `Comment ${commentId} removed. Total: ${state.session.comments.length}.`,
				},
			],
			details: { action: "remove-comment", commentId },
		};
	}

	async function handleResume(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		// During file review, re-open the tabbed file panel
		if (state.phase === "files") {
			return handleReviewFiles(ctx);
		}

		return textResult(
			`Resuming PR review at phase: ${state.phase}. ` +
				`Comments: ${state.session.comments.length}.`,
		);
	}

	async function handleVet(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		state.phase = "vetting";
		const session = state.session;

		if (session.comments.length === 0) {
			return textResult(
				"No comments to vet. Add comments first, or call 'post' " +
					"to submit a review with just a summary body.",
			);
		}

		const hasBlocking = session.comments.some((c) =>
			c.decorations.includes("blocking"),
		);
		const suggestedVerdict = hasBlocking ? "REQUEST_CHANGES" : "COMMENT";

		const draftBody =
			session.body ||
			`Review of ${session.pr.owner}/${session.pr.repo}#${session.pr.number}.`;

		const vettingResult = await showVetting(
			ctx,
			session.comments,
			suggestedVerdict,
			draftBody,
		);

		if (!vettingResult) {
			return textResult("Vetting cancelled. Call 'vet' to retry.");
		}

		// Steer — user wants to edit verdict, body, or a comment
		if (vettingResult.steerFeedback) {
			const editComment = vettingResult.steerCommentId
				? session.comments.find((c) => c.id === vettingResult.steerCommentId)
				: null;

			const parts: string[] = [
				`User feedback during vetting:\n\n"${vettingResult.steerFeedback}"`,
				"",
			];

			if (editComment) {
				parts.push(
					"Comment being edited:",
					`- File: ${editComment.file}:${editComment.startLine}-${editComment.endLine}`,
					`- Label: ${editComment.label}`,
					`- Subject: ${editComment.subject}`,
					`- Discussion: ${editComment.discussion}`,
					"",
					"Use 'update-comment' to revise this comment, then call 'vet' again.",
				);
			} else {
				parts.push(
					`Current verdict: ${suggestedVerdict}`,
					`Current body: ${draftBody}`,
					"",
					"If the user wants to change the verdict or review body, " +
						"make the changes and call 'vet' again. " +
						"If they want to edit a comment, use 'update-comment'.",
				);
			}

			return {
				content: [{ type: "text" as const, text: parts.join("\n") }],
				details: { action: "vet", steered: true },
			};
		}

		// Apply decisions
		applyVettingDecisions(session, vettingResult);
		persist(state, pi);

		// Post immediately if user pressed 'p' from summary tab
		if (vettingResult.postNow) {
			return handlePost();
		}

		const accepted = commentsByStatus(session, "accepted").length;
		const rejected = commentsByStatus(session, "rejected").length;

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Vetting complete. ${accepted} accepted, ${rejected} rejected. ` +
						`Verdict: ${session.verdict}. Call 'post' to submit the review.`,
				},
			],
			details: {
				action: "vet",
				phase: "vetting",
				accepted,
				rejected,
				verdict: session.verdict,
			},
		};
	}

	async function handlePost() {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		state.phase = "posting";
		const session = state.session;
		const ref: PRReference = {
			owner: session.pr.owner,
			repo: session.pr.repo,
			number: session.pr.number,
		};

		const accepted = commentsByStatus(session, "accepted");
		const ghComments = accepted.map(formatGitHubComment);

		try {
			await postReview(pi, ref, session.body, session.verdict, ghComments);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Review posted on ${ref.owner}/${ref.repo}#${ref.number}. ` +
							`${ghComments.length} comment(s), verdict: ${session.verdict}. ` +
							"Call 'deactivate' to exit.",
					},
				],
				details: {
					action: "posted",
					comments: ghComments.length,
					verdict: session.verdict,
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return textResult(`Failed to post review: ${msg}`);
		}
	}

	async function handleDeactivate(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("PR review is not active.");
		}

		const session = state.session;

		if (session.usingWorktree) {
			try {
				await removeWorktree(pi, session.pr.number);
			} catch {
				/* Worktree cleanup failed — not fatal */
			}
		}

		const commentCount = session.comments.length;
		const prNum = session.pr.number;

		deactivate(state, pi, ctx);

		return {
			content: [
				{
					type: "text" as const,
					text: `PR review for #${prNum} complete. ${commentCount} comments collected.`,
				},
			],
			details: { action: "deactivated" },
		};
	}
}

// ---- Module-level helpers ----

/** Get current repo from git remote. */
async function getCurrentRepo(
	pi: ExtensionAPI,
): Promise<{ owner: string; repo: string } | null> {
	const result = await pi.exec("git", ["config", "--get", "remote.origin.url"]);
	if (result.code !== 0) return null;
	return extractOwnerRepo(result.stdout.trim());
}

/** Build a simple text tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

/** Apply vetting decisions to the session's comments. */
function applyVettingDecisions(
	session: ReviewSession,
	result: VettingResult,
): void {
	for (const [commentId, decision] of result.decisions) {
		const comment = session.comments.find((c) => c.id === commentId);
		if (comment) {
			comment.status = decision;
		}
	}
	session.verdict = result.verdict;
	session.body = result.reviewBody;
}

/** Format a review comment for the GitHub API. */
function formatGitHubComment(c: {
	file: string;
	startLine: number;
	endLine: number;
	label: string;
	decorations: string[];
	subject: string;
	discussion: string;
}) {
	const decorStr =
		c.decorations.length > 0 ? ` (${c.decorations.join(", ")})` : "";
	const body = `${c.label}${decorStr}: ${c.subject}\n\n${c.discussion}`;

	const comment: {
		path: string;
		line: number;
		start_line?: number;
		side: string;
		start_side?: string;
		body: string;
	} = {
		path: c.file,
		line: c.endLine,
		side: "RIGHT",
		body,
	};

	if (c.startLine !== c.endLine) {
		comment.start_line = c.startLine;
		comment.start_side = "RIGHT";
	}

	return comment;
}
