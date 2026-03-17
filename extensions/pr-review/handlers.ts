/**
 * PR Review action handlers — thin functions that guard,
 * operate, and return briefings.
 *
 * Each handler receives a HandlerDeps bundle. The index.ts
 * switch statement delegates to these.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { PRReference } from "./api/parse.js";
import { extractOwnerRepo, parsePRReference } from "./api/parse.js";
import { resolveRepo } from "./api/repo.js";
import { briefActivation, briefGenerateComments } from "./briefing.js";
import { crawl } from "./crawler.js";
import { activate, deactivate, persist, refreshUI } from "./lifecycle.js";
import {
	addComment,
	commentStats,
	createSession,
	type PRReviewState,
	removeComment,
	updateComment,
} from "./state.js";

// ---- Types ----

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

/** Stub result for unimplemented handlers. */
function notImplemented(action: string) {
	return textResult(`Action '${action}' is not implemented yet.`);
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

// ---- Handlers ----

/** Activate: parse PR ref, resolve repo, crawl deep context. */
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

	// Resolve repo on disk
	const repoResult = await resolveRepo(pi, ref.owner, ref.repo, ref.number);

	if (repoResult.status === "switched") {
		return textResult(
			`PR #${ref.number} belongs to ${ref.owner}/${ref.repo}. ` +
				`Opened a new tab at ${repoResult.repoPath}. ` +
				"Continue the review there.",
		);
	}

	if (repoResult.status === "switch-failed") {
		return textResult(
			`Found repo at ${repoResult.repoPath} but couldn't open a new tab. ` +
				`cd to that directory and run the review there.`,
		);
	}

	if (repoResult.status === "not-found") {
		return textResult(
			`Could not find ${ref.owner}/${ref.repo} on disk. ` +
				"Clone the repo and try again.",
		);
	}

	// Activate and crawl
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
		const crawlResult = await crawl(
			pi,
			ref,
			repoResult.repoPath,
			(_depth, label) => {
				ctx.ui.notify(label, "info");
			},
		);

		// Update session with crawl results
		session.context = crawlResult;
		session.pr.branch = crawlResult.pr.headRefName;
		session.pr.baseBranch = crawlResult.pr.baseRefName;
		session.pr.author = crawlResult.pr.author;
		session.phase = "overview";

		persist(state, pi);
		refreshUI(state, ctx);

		const briefing = briefActivation(session);

		return {
			content: [{ type: "text" as const, text: briefing }],
			details: {
				action: "activate",
				fileCount: crawlResult.diffFiles.length,
				issueCount: crawlResult.issues.length,
				referenceCount: crawlResult.references.length,
				reviewerCount: crawlResult.reviewers.length,
			},
		};
	} catch (err) {
		deactivate(state, pi, ctx);
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`Failed to gather PR context: ${msg}`);
	}
}

/** Generate comments: agent provides analysis and structured comments. */
export async function handleGenerateComments(
	deps: HandlerDeps,
	synopsis: string | null,
	scopeAnalysis: string | null,
	sourceRoles: SourceRoleInput[] | null,
	comments: CommentInput[] | null,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return textResult("No PR review active. Call 'activate' first.");
	}

	const session = state.session;

	// Store synopsis and scope analysis
	if (synopsis) session.synopsis = synopsis;
	if (scopeAnalysis) session.scopeAnalysis = scopeAnalysis;

	// Fill in source file roles
	if (sourceRoles && session.context) {
		for (const sr of sourceRoles) {
			const sourceFile = session.context.sourceFiles.find(
				(f) => f.path === sr.path,
			);
			if (sourceFile) sourceFile.role = sr.role;
		}
	}

	// Add comments
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

	const summary = briefGenerateComments(session);

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
	_deps: HandlerDeps,
	_ctx: ExtensionContext,
) {
	return notImplemented("overview");
}

/** Review: show Phase 2 review panel. */
export async function handleReview(_deps: HandlerDeps, _ctx: ExtensionContext) {
	return notImplemented("review");
}

/** Add a review comment. */
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
					`Comment added: ${reviewComment.label}${decorStr} — ` +
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

/** Remove a comment by ID. */
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

/** Submit: show final review summary panel. */
export async function handleSubmit(
	_deps: HandlerDeps,
	_ctx: ExtensionContext,
	_reviewBody: string | null,
	_verdict: string | null,
) {
	return notImplemented("submit");
}

/** Post: submit review to GitHub. */
export async function handlePost(deps: HandlerDeps) {
	const { state, pi } = deps;

	if (!state.session) {
		return textResult("No PR review active.");
	}

	const session = state.session;
	const stats = commentStats(session);

	if (stats.pending > 0) {
		return textResult(
			`${stats.pending} comment${stats.pending !== 1 ? "s are" : " is"} still pending — ` +
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
	const ghComments = approved
		.filter((c) => c.file !== null)
		.map((c) => {
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
				path: c.file as string,
				line: c.endLine ?? 1,
				side: "RIGHT",
				body,
			};

			if (
				c.startLine !== null &&
				c.endLine !== null &&
				c.startLine !== c.endLine
			) {
				comment.start_line = c.startLine;
				comment.start_side = "RIGHT";
			}

			return comment;
		});

	try {
		await postReview(pi, ref, session.reviewBody, session.verdict, ghComments);

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

/** Deactivate: clean up and exit review mode. */
export async function handleDeactivate(
	deps: HandlerDeps,
	ctx: ExtensionContext,
) {
	const { state, pi } = deps;

	if (!state.session) {
		return textResult("PR review is not active.");
	}

	const commentCount = state.session.comments.length;
	const prNum = state.session.pr.number;

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
