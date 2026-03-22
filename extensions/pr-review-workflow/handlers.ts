/**
 * PR Review action handlers: thin functions that guard,
 * operate, and return briefings.
 *
 * Each handler receives a ReviewContext bundle. The index.ts
 * switch statement delegates to these.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { buildHunkRanges, clampToHunkRange } from "../lib/github/diff.js";
import {
	type PRReference,
	parsePRReference,
} from "../lib/github/pr-reference.js";
import { getCurrentRepo, resolveRepo } from "../lib/github/repo-discovery.js";
import { activationBriefing, generateCommentsBriefing } from "./briefing.js";
import { gatherContext } from "./gather.js";
import { activate, deactivate, persist, refreshUI } from "./lifecycle.js";
import {
	addComment,
	commentStats,
	createSession,
	type PRReviewState,
	removeComment,
	updateComment,
} from "./state.js";
import { createWorktree, isOnPRBranch, removeWorktree } from "./worktree.js";

/** Structured comment input from the tool parameters. */
export interface CommentInput {
	file: string | null;
	startLine: number | null;
	endLine: number | null;
	label: string;
	decorations: string[];
	subject: string;
	discussion: string;
	category: "file" | "title" | "scope";
}

/** Source file role description from generate-comments. */
export interface SourceRoleInput {
	path: string;
	role: string;
}

/** Reference summary from generate-comments. */
export interface ReferenceSummaryInput {
	url: string;
	summary: string;
}

/** Dependencies shared by all handlers. */
export interface ReviewContext {
	state: PRReviewState;
	pi: ExtensionAPI;
}

/** Activate: parse PR ref, resolve repo, gather deep context. */
export async function handleActivate(
	deps: ReviewContext,
	ctx: ExtensionContext,
	prInput: string | null,
	userRequest: string | null = null,
) {
	const { state, pi } = deps;

	if (state.session) {
		return plainTextResponse(
			`PR review is already active for #${state.session.pr.number}. ` +
				"Call 'deactivate' first to start a new review.",
		);
	}

	const ref = await resolvePR(pi, prInput);
	if (!ref) {
		return plainTextResponse(
			"Could not determine which PR to review. " +
				"Provide a PR URL, number (#123), or owner/repo#number.",
		);
	}

	// We resolve the repo on disk.
	const repoResult = await resolveRepo(
		pi,
		ref.owner,
		ref.repo,
		userRequest ?? `review ${ref.owner}/${ref.repo}#${ref.number}`,
	);

	if (repoResult.status === "opened-tab") {
		return plainTextResponse(
			`PR #${ref.number} belongs to ${ref.owner}/${ref.repo}, which is a different repository. ` +
				`A new terminal tab has been opened at ${repoResult.repoPath} with a pi session ` +
				"handling the review. Do NOT call pr_review again in this session: " +
				"the new tab has all the context it needs. This task is complete.",
		);
	}

	if (repoResult.status === "open-failed") {
		return plainTextResponse(
			`Found repo at ${repoResult.repoPath} but couldn't open a new tab. ` +
				`cd to that directory and run the review there.`,
		);
	}

	if (repoResult.status === "not-found") {
		return plainTextResponse(
			`Could not find ${ref.owner}/${ref.repo} on disk. ` +
				"Clone the repo and try again.",
		);
	}

	// We activate and gather context.
	state.enabled = true;
	const session = createSession(
		{
			owner: ref.owner,
			repo: ref.repo,
			number: ref.number,
			branch: "",
			baseBranch: "",
			author: "",
		},
		repoResult.repoPath,
	);
	state.session = session;
	session.phase = "gathering";
	activate(state, pi, ctx);

	ctx.ui.notify(`Gathering context for PR #${ref.number}…`, "info");

	try {
		const prContext = await gatherContext(
			pi,
			ref,
			repoResult.repoPath,
			(_depth, label) => {
				ctx.ui.notify(label, "info");
			},
		);

		// We update the session with gathered context.
		session.context = prContext;
		session.pr.branch = prContext.pr.headRefName;
		session.pr.baseBranch = prContext.pr.baseRefName;
		session.pr.author = prContext.pr.author;

		// We create a worktree if we're not on the PR branch.
		const onBranch = await isOnPRBranch(pi, prContext.pr.headRefName);
		if (!onBranch) {
			ctx.ui.notify("Creating worktree for PR branch…", "info");
			const wtPath = await createWorktree(pi, ref.number);
			if (wtPath) {
				session.worktreePath = wtPath;
				session.repoPath = wtPath;
			}
		}

		session.phase = "overview";

		persist(state, pi);
		refreshUI(state, ctx);

		const briefing = activationBriefing(session);

		return {
			content: [{ type: "text" as const, text: briefing }],
			details: {
				action: "activate",
				fileCount: prContext.diffFiles.length,
				issueCount: prContext.issues.length,
				referenceCount: prContext.references.length,
				reviewerCount: prContext.reviewers.length,
			},
		};
	} catch (err) {
		deactivate(state, pi, ctx);
		const msg = err instanceof Error ? err.message : String(err);
		return plainTextResponse(`Failed to gather PR context: ${msg}`);
	}
}

/** Generate comments: agent provides analysis and structured comments. */
export async function handleGenerateComments(
	deps: ReviewContext,
	synopsis: string | null,
	scopeAnalysis: string | null,
	sourceRoles: SourceRoleInput[] | null,
	referenceSummaries: ReferenceSummaryInput[] | null,
	comments: CommentInput[] | null,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active. Call 'activate' first.");
	}

	const session = state.session;

	// We store the synopsis and scope analysis.
	if (synopsis) session.synopsis = synopsis;
	if (scopeAnalysis) session.scopeAnalysis = scopeAnalysis;

	// We fill in the source file roles.
	if (sourceRoles && session.context) {
		for (const sr of sourceRoles) {
			const sourceFile = session.context.sourceFiles.find(
				(f) => f.path === sr.path,
			);
			if (sourceFile) sourceFile.role = sr.role;
		}
	}

	// We fill in reference summaries (replacing raw body previews with AI summaries).
	if (referenceSummaries && session.context) {
		for (const rs of referenceSummaries) {
			const ref = session.context.references.find((r) => r.url === rs.url);
			if (ref) ref.description = rs.summary;
		}
	}

	// We add the comments.
	if (comments) {
		for (const c of comments) {
			addComment(session, {
				file: c.file,
				startLine: c.startLine,
				endLine: c.endLine,
				label: c.label,
				decorations: c.decorations,
				subject: c.subject,
				discussion: c.discussion,
				source: "ai",
				category: c.category,
			});
		}
	}

	persist(state, pi);

	const summary = generateCommentsBriefing(session);

	return {
		content: [{ type: "text" as const, text: summary }],
		details: {
			action: "generate-comments",
			commentCount: session.comments.length,
		},
	};
}

/** Overview: show Phase 1 overview panel. */
export async function handleOverview(
	deps: ReviewContext,
	ctx: ExtensionContext,
) {
	const { state } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active. Call 'activate' first.");
	}

	const session = state.session;
	if (!(await ensureContext(deps, ctx))) {
		return plainTextResponse("Failed to load PR context.");
	}

	session.phase = "overview";
	refreshUI(state, ctx);

	const { showOverviewPanel } = await import("./ui/overview-panel.js");
	const result = await showOverviewPanel(
		ctx,
		session.context,
		session.synopsis,
	);

	if (!result) {
		return plainTextResponse(
			"Overview panel dismissed. Call 'overview' to re-show, " +
				"or 'review' to proceed.",
		);
	}

	if (result.action === "review") {
		return plainTextResponse(
			"User chose to proceed to review. Call 'review' to show the review panel.",
		);
	}

	if (result.action === "redirect") {
		return {
			content: [
				{
					type: "text" as const,
					text:
						`User feedback from overview panel:\n\n"${result.note}"\n\n` +
						"Process the feedback and call 'overview' to re-open the panel.",
				},
			],
			details: { action: "overview", redirected: true },
		};
	}

	return plainTextResponse("Overview complete.");
}

/** Review: show Phase 2 review panel. */
export async function handleReview(deps: ReviewContext, ctx: ExtensionContext) {
	const { state } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active. Call 'activate' first.");
	}

	const session = state.session;
	if (!(await ensureContext(deps, ctx))) {
		return plainTextResponse("Failed to load PR context.");
	}

	session.phase = "reviewing";
	refreshUI(state, ctx);

	const { showReviewPanel } = await import("./ui/review-panel.js");
	const result = await showReviewPanel(ctx, session);

	persist(state, deps.pi);
	refreshUI(state, ctx);

	if (!result) {
		return plainTextResponse(
			"Review panel dismissed. Call 'review' to re-show, " +
				"or 'submit' to proceed.",
		);
	}

	if (result.action === "submit") {
		return plainTextResponse(
			"User submitted from review panel. Call 'submit' to show the submit panel.",
		);
	}

	if (result.action === "redirect") {
		const parts: string[] = [];
		parts.push(`User feedback from review panel:\n\n"${result.note}"`);

		if (result.commentId) {
			const comment = session.comments.find((c) => c.id === result.commentId);
			if (comment) {
				parts.push("");
				parts.push("Comment being redirected:");
				parts.push(`- ID: ${comment.id}`);
				parts.push(`- File: ${comment.file ?? "(PR-level)"}`);
				if (comment.startLine !== null) {
					parts.push(`- Lines: ${comment.startLine}-${comment.endLine}`);
				}
				parts.push(`- Label: ${comment.label}`);
				parts.push(`- Subject: ${comment.subject}`);
				parts.push(`- Discussion: ${comment.discussion}`);
				parts.push("");
				parts.push(
					"Use 'update-comment' with this comment_id to revise it, " +
						"then call 'review' to re-open the panel.",
				);
			}
		} else {
			parts.push(
				"\n\nProcess the feedback and call 'review' to re-open the panel.",
			);
		}

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "review", redirected: true },
		};
	}

	return plainTextResponse("Review complete.");
}

/** Add a review comment. */
export function handleAddComment(
	deps: ReviewContext,
	comment: CommentInput | undefined,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active.");
	}

	if (!comment) {
		return plainTextResponse(
			"Provide a comment object with: file, startLine, endLine, " +
				"label, decorations, subject, discussion, category.",
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
		source: "user",
		category: comment.category,
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
					`Comment added: ${reviewComment.label}${decorStr}: ` +
					`${reviewComment.subject}\n` +
					`Total: ${state.session.comments.length} comments.`,
			},
		],
		details: {
			action: "add-comment",
			commentId: reviewComment.id,
			total: state.session.comments.length,
		},
	};
}

/** Update an existing comment. */
export function handleUpdateComment(
	deps: ReviewContext,
	commentId: string | null,
	comment: CommentInput | undefined,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active.");
	}

	if (!commentId) {
		return plainTextResponse(
			"Provide comment_id to identify which comment to update.",
		);
	}

	if (!comment) {
		return plainTextResponse(
			"Provide a comment object with the updated fields.",
		);
	}

	const found = updateComment(state.session, commentId, comment);
	if (!found) {
		return plainTextResponse(`Comment ${commentId} not found.`);
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

/** Remove a comment by ID. */
export function handleRemoveComment(
	deps: ReviewContext,
	commentId: string | null,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active.");
	}

	if (!commentId) {
		return plainTextResponse(
			"Provide comment_id to identify which comment to remove.",
		);
	}

	const found = removeComment(state.session, commentId);
	if (!found) {
		return plainTextResponse(`Comment ${commentId} not found.`);
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

/** Submit: show final review summary panel. */
export async function handleSubmit(
	deps: ReviewContext,
	ctx: ExtensionContext,
	reviewBody: string | null,
	verdict: string | null,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active. Call 'activate' first.");
	}

	const session = state.session;

	// We update body/verdict if they were provided.
	if (reviewBody !== null) session.reviewBody = reviewBody;
	if (verdict !== null && isReviewVerdict(verdict)) {
		session.verdict = verdict;
	}

	session.phase = "submitting";
	refreshUI(state, ctx);

	const { showSubmitPanel } = await import("./ui/submit-panel.js");
	const result = await showSubmitPanel(ctx, session);

	persist(state, pi);

	if (!result) {
		return plainTextResponse(
			"Submit panel dismissed. Call 'submit' to re-show, " +
				"or 'review' to go back.",
		);
	}

	if (result.action === "post") {
		return handlePost(deps);
	}

	if (result.action === "redirect") {
		return {
			content: [
				{
					type: "text" as const,
					text:
						`User feedback from submit panel:\n\n"${result.note}"\n\n` +
						`Current body: ${session.reviewBody || "(empty)"}\n` +
						`Current verdict: ${session.verdict}\n\n` +
						"Update the body/verdict as needed, then call 'submit' again.",
				},
			],
			details: { action: "submit", redirected: true },
		};
	}

	return plainTextResponse("Submit flow complete.");
}

/** Post: submit review to GitHub. */
export async function handlePost(deps: ReviewContext) {
	const { state, pi } = deps;

	if (!state.session) {
		return plainTextResponse("No PR review active.");
	}

	const session = state.session;
	const stats = commentStats(session);

	if (stats.pending > 0) {
		return plainTextResponse(
			`${stats.pending} comment${stats.pending !== 1 ? "s are" : " is"} still pending: ` +
				"review all comments before posting.",
		);
	}

	session.phase = "submitting";
	const { postReview } = await import("./api/github.js");

	const ref: PRReference = {
		owner: session.pr.owner,
		repo: session.pr.repo,
		number: session.pr.number,
	};

	const approved = session.comments.filter((c) => c.status === "approved");

	// We build hunk ranges per file so we can clamp comment lines.
	const diffFiles = session.context?.diffFiles ?? [];
	const hunkRanges = buildHunkRanges(diffFiles);

	const ghComments = approved
		.filter((c) => c.file !== null)
		.map((c) => {
			const decorStr =
				c.decorations.length > 0 ? ` (${c.decorations.join(", ")})` : "";
			const body = `${c.label}${decorStr}: ${c.subject}\n\n${c.discussion}`;

			const ranges = hunkRanges.get(c.file as string);
			const endLine = clampToHunkRange(c.endLine ?? 1, ranges);

			const comment: {
				path: string;
				line: number;
				start_line?: number;
				side: string;
				start_side?: string;
				body: string;
			} = {
				path: c.file as string,
				line: endLine,
				side: "RIGHT",
				body,
			};

			if (
				c.startLine !== null &&
				c.endLine !== null &&
				c.startLine !== c.endLine
			) {
				const startLine = clampToHunkRange(c.startLine, ranges);
				if (startLine < endLine) {
					comment.start_line = startLine;
					comment.start_side = "RIGHT";
				}
			}

			return comment;
		});

	try {
		await postReview(pi, ref, session.verdict, session.reviewBody, ghComments);

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
		return plainTextResponse(`Failed to post review: ${msg}`);
	}
}

/** Deactivate: clean up and exit review mode. */
export async function handleDeactivate(
	deps: ReviewContext,
	ctx: ExtensionContext,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return plainTextResponse("PR review is not active.");
	}

	const commentCount = state.session.comments.length;
	const prNum = state.session.pr.number;

	// We clean up the worktree if we created one.
	if (state.session.worktreePath) {
		try {
			await removeWorktree(pi, prNum);
		} catch {
			/* Worktree cleanup failed: not fatal */
		}
	}

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

/** Build a simple text tool result. */
function plainTextResponse(text: string) {
	return { content: [{ type: "text" as const, text }] };
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
 * restored but context was lost, re-gather transparently.
 */
async function ensureContext(
	deps: ReviewContext,
	ctx: ExtensionContext,
): Promise<boolean> {
	const session = deps.state.session;
	if (!session) return false;
	if (session.context) return true;

	ctx.ui.notify("Re-fetching PR context…", "info");

	try {
		const ref: PRReference = {
			owner: session.pr.owner,
			repo: session.pr.repo,
			number: session.pr.number,
		};
		const prContext = await gatherContext(deps.pi, ref, session.repoPath);
		session.context = prContext;
		return true;
	} catch {
		/* Re-gather failed: context unavailable */
		return false;
	}
}

const VALID_VERDICTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

/** Validate an LLM-provided review verdict string. */
function isReviewVerdict(
	s: string,
): s is "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
	return VALID_VERDICTS.has(s);
}
