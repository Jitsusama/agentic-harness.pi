/**
 * PR Review action handlers — thin functions that guard,
 * operate, and return briefings.
 *
 * Each handler receives a HandlerDeps bundle with everything
 * it needs (state, pi, lifecycle, API, UI). The index.ts
 * switch statement delegates to these.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
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
import { activate, deactivate, persist, refreshUI } from "./lifecycle.js";
import {
	addComment,
	commentsByStatus,
	createSession,
	type LinkedIssue,
	type PRReviewState,
	type ReviewSession,
	removeComment,
	updateComment,
} from "./state.js";
import { showContextSummary } from "./ui/context-summary.js";
import { showDescriptionReview } from "./ui/description.js";
import { showFileReview } from "./ui/file-review.js";
import { showVetting, type VettingResult } from "./ui/vetting.js";
import { createWorktree, isOnPRBranch, removeWorktree } from "./worktree.js";

// ---- Types ----

/** Structured comment data from the tool parameters. */
export interface CommentInput {
	file: string;
	startLine: number;
	endLine: number;
	label: string;
	decorations: string[];
	subject: string;
	discussion: string;
}

/** Dependencies shared by all handlers. */
export interface HandlerDeps {
	state: PRReviewState;
	pi: ExtensionAPI;
}

// ---- Helpers ----

/** Build a simple text tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

/** Get current repo from git remote. */
async function getCurrentRepo(
	pi: ExtensionAPI,
): Promise<{ owner: string; repo: string } | null> {
	const result = await pi.exec("git", ["config", "--get", "remote.origin.url"]);
	if (result.code !== 0) return null;
	return extractOwnerRepo(result.stdout.trim());
}

/** Resolve a PR reference from user input. */
async function resolvePR(
	pi: ExtensionAPI,
	prInput: string | null,
): Promise<PRReference | null> {
	const currentRepo = await getCurrentRepo(pi);
	if (prInput) {
		return parsePRReference(prInput, currentRepo?.owner, currentRepo?.repo);
	}
	return null;
}

/**
 * Ensure gathered context is available. If the session was
 * restored but context was lost, re-fetch transparently.
 */
async function ensureContext(
	{ state, pi }: HandlerDeps,
	ctx: ExtensionContext,
): Promise<boolean> {
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
		const siblingPRs = await fetchSiblingPRs(pi, ref, graphqlData.issues);
		session.context = assembleContext(
			graphqlData.pr,
			diff,
			graphqlData.prComments,
			graphqlData.issues,
			siblingPRs,
		);
		return true;
	} catch {
		/* Re-fetch failed — context unavailable */
		return false;
	}
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
function formatGitHubComment(c: ReviewSession["comments"][number]) {
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
	} = { path: c.file, line: c.endLine, side: "RIGHT", body };

	if (c.startLine !== c.endLine) {
		comment.start_line = c.startLine;
		comment.start_side = "RIGHT";
	}

	return comment;
}

// ---- Handlers ----

export async function handleActivate(
	deps: HandlerDeps,
	ctx: ExtensionContext,
	prInput: string | null,
) {
	const { state, pi } = deps;

	if (state.session) {
		return textResult(
			`PR review is already active for #${state.session.pr.number}. ` +
				"Call 'deactivate' first to start a new review.",
		);
	}

	const ref = await resolvePR(pi, prInput);
	if (!ref) {
		return textResult(
			"Could not determine which PR to review. " +
				"Provide a PR URL, number (#123), or owner/repo#number.",
		);
	}

	state.phase = "gathering";
	state.enabled = true;
	activate(state, pi, ctx);

	let fetchedIssues: LinkedIssue[] = [];
	let fetchedAuthor = "";
	let graphqlDone: () => void;
	let graphqlFailed: (err: unknown) => void;
	const graphqlReady = new Promise<void>((resolve, reject) => {
		graphqlDone = resolve;
		graphqlFailed = reject;
	});

	const results = await progress(
		ctx,
		{ title: `Gathering context for PR #${ref.number}…` },
		[
			{
				label: "PR metadata & issues",
				run: async () => {
					try {
						const data = await fetchPRGraphQL(pi, ref);
						fetchedIssues = data.issues;
						fetchedAuthor = data.pr.author;
						graphqlDone();
						return data;
					} catch (err) {
						graphqlFailed(err);
						throw err;
					}
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

export async function handleContext(deps: HandlerDeps, ctx: ExtensionContext) {
	const { state } = deps;

	if (!state.session) {
		return textResult("No PR review active. Call 'activate' first.");
	}
	if (!(await ensureContext(deps, ctx))) {
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

export async function handleDescription(
	deps: HandlerDeps,
	ctx: ExtensionContext,
) {
	const { state } = deps;

	if (!state.session) {
		return textResult("No PR review active. Call 'activate' first.");
	}
	if (!(await ensureContext(deps, ctx))) {
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

export async function handleAnalyze(deps: HandlerDeps, ctx: ExtensionContext) {
	const { state } = deps;

	if (!state.session) {
		return textResult("No PR review active. Call 'activate' first.");
	}
	if (!(await ensureContext(deps, ctx))) {
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

export async function handleReviewFiles(
	deps: HandlerDeps,
	ctx: ExtensionContext,
) {
	const { state } = deps;

	if (!state.session) {
		return textResult("No PR review active. Call 'activate' first.");
	}
	if (!(await ensureContext(deps, ctx))) {
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

export function handleAddComment(
	deps: HandlerDeps,
	comment: CommentInput | undefined,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return textResult("No PR review active.");
	}

	if (!comment) {
		return textResult(
			"Provide a comment object with: file, startLine, endLine, " +
				"label, decorations, subject, discussion.",
		);
	}

	const reviewComment = addComment(state.session, {
		file: comment.file,
		startLine: comment.startLine,
		endLine: comment.endLine,
		label: comment.label,
		decorations: comment.decorations,
		subject: comment.subject,
		discussion: comment.discussion,
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

export function handleUpdateComment(
	deps: HandlerDeps,
	commentId: string | null,
	comment: CommentInput | undefined,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return textResult("No PR review active.");
	}

	if (!commentId) {
		return textResult(
			"Provide comment_id to identify which comment to update.",
		);
	}

	if (!comment) {
		return textResult("Provide a comment object with the updated fields.");
	}

	const found = updateComment(state.session, commentId, comment);
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

export function handleRemoveComment(
	deps: HandlerDeps,
	commentId: string | null,
) {
	const { state, pi } = deps;

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

export async function handleResume(deps: HandlerDeps, ctx: ExtensionContext) {
	const { state } = deps;

	if (!state.session) {
		return textResult("No PR review active.");
	}

	switch (state.phase) {
		case "context":
			return handleContext(deps, ctx);
		case "description":
			return handleDescription(deps, ctx);
		case "files":
			return handleReviewFiles(deps, ctx);
		case "vetting":
			return handleVet(deps, ctx);
		default:
			return textResult(
				`Resuming PR review at phase: ${state.phase}. ` +
					`Comments: ${state.session.comments.length}.`,
			);
	}
}

export async function handleVet(deps: HandlerDeps, ctx: ExtensionContext) {
	const { state, pi } = deps;

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

	applyVettingDecisions(session, vettingResult);
	persist(state, pi);

	if (vettingResult.postNow) {
		return handlePost(deps);
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

export async function handlePost(deps: HandlerDeps) {
	const { state, pi } = deps;

	if (!state.session) {
		return textResult("No PR review active.");
	}

	const session = state.session;
	const drafts = commentsByStatus(session, "draft");
	if (drafts.length > 0) {
		return textResult(
			`${drafts.length} comment${drafts.length !== 1 ? "s are" : " is"} still draft — ` +
				"call 'vet' first so the user can approve or reject each comment before posting.",
		);
	}

	state.phase = "posting";
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

export async function handleDeactivate(
	deps: HandlerDeps,
	ctx: ExtensionContext,
) {
	const { state, pi } = deps;

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
