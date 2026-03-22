/**
 * PR Reply action handlers: each function handles one tool
 * action and returns a tool result for the LLM.
 *
 * Pure orchestration: read state, call domain functions,
 * show UI panels, update state, return briefings.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { resolveRepo } from "../lib/github/repo-discovery.js";
import { buildAnalysisPrompt } from "./analysis.js";
import {
	fetchReviews,
	type PRReference,
	postReply,
	refreshThreadComments,
} from "./api/github.js";
import { findDependentPRs, getCurrentBranch } from "./api/repo.js";
import {
	briefActivation,
	briefBatchAnalysis,
	briefCompletion,
	briefImplementChoice,
	briefProgress,
	briefReAnalyze,
	briefRebaseApproved,
	briefRedirect,
	briefReplyChoice,
	briefReviewSummary,
	briefThread,
} from "./briefing.js";
import {
	beginTDDImplementation,
	buildImplementationContext,
	collectImplementationCommits,
	linkCommitsToThread,
	recordImplementationStart,
	shortSHAs,
} from "./implementation.js";
import { activate, deactivate, persist, refreshUI } from "./lifecycle.js";
import {
	getPRBranch,
	pushIfNeeded,
	readCodeContext,
	resolvePR,
} from "./navigation.js";
import { findPlanContext } from "./plans.js";
import { buildReplyGuidance } from "./replies.js";
import {
	type DependentPR,
	type PRReplyState,
	sortReviewsByPriority,
	type Thread,
	threadsForReview,
} from "./state.js";
import {
	showRebasePanel,
	showReviewOverviewPanel,
	showSummaryPanel,
} from "./ui/panels.js";
import { showReplyReview } from "./ui/reply-review.js";
import { showThreadGate, type ThreadGateChoice } from "./ui/thread-gate.js";
import { showReplyWorkspace } from "./ui/workspace.js";

/** Build a simple text tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

const VALID_RECOMMENDATIONS = new Set(["implement", "reply", "pass"]);

/** Validate an LLM-provided recommendation string. */
function isRecommendation(s: string): s is "implement" | "reply" | "pass" {
	return VALID_RECOMMENDATIONS.has(s);
}

/** Get the current thread based on review-centric navigation. */
/** Get the current thread: from workspace selection or legacy navigation. */
function currentThread(state: PRReplyState): Thread | null {
	// Workspace flow: currentThreadId is set by the workspace
	if (state.currentThreadId) {
		return state.threads.find((t) => t.id === state.currentThreadId) ?? null;
	}
	// Legacy flow: review-centric navigation
	const review = state.reviews[state.reviewIndex];
	if (!review) return null;
	const reviewThreads = threadsForReview(review, state.threads);
	return reviewThreads[state.threadIndexInReview] ?? null;
}

/** Find the next pending thread within a review's threads. */
function findNextPendingInReview(
	state: PRReplyState,
	reviewThreads: Thread[],
): Thread | null {
	for (const thread of reviewThreads) {
		if (state.threadStates.get(thread.id) === "pending") {
			return thread;
		}
	}
	return null;
}

/** Activate PR reply mode: load reviews and show summary. */
export async function handleActivate(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prInput: string | null,
	userRequest: string | null = null,
) {
	if (state.enabled) {
		return textResult(
			`PR reply mode is already active for PR #${state.prNumber}.`,
		);
	}

	const ref = await resolvePR(pi, prInput);
	if (!ref) {
		return textResult(
			"Could not determine which PR to review. " +
				"Provide a PR URL, number, or navigate to the branch.",
		);
	}

	const repoResult = await resolveRepo(
		pi,
		ref.owner,
		ref.repo,
		userRequest ??
			`respond to reviews on ${ref.owner}/${ref.repo}#${ref.number}`,
	);
	if (repoResult.status !== "current") {
		return handleRepoResult(ctx, repoResult, ref);
	}

	// We ensure we're on the PR's branch.
	const prBranch = await getPRBranch(pi, ref);
	if (prBranch) {
		const currentBranch = await getCurrentBranch(pi);
		if (currentBranch !== prBranch) {
			const checkout = await pi.exec("git", ["checkout", prBranch]);
			if (checkout.code !== 0) {
				return textResult(
					`Failed to switch to branch '${prBranch}': ${checkout.stderr}\n` +
						`You're on '${currentBranch}'. Switch manually and retry.`,
				);
			}
			ctx.ui.notify(`Switched to branch ${prBranch}`, "info");
		}
	}

	ctx.ui.notify("Fetching reviews…", "info");
	const data = await fetchReviews(pi, ref);

	const dismissedCount = data.reviews.filter(
		(r) => r.state === "DISMISSED",
	).length;
	const activeReviews = data.reviews.filter((r) => r.state !== "DISMISSED");
	const unresolvedThreads = data.threads.filter((t) => !t.isResolved);

	if (unresolvedThreads.length === 0) {
		return textResult("No unresolved review threads to address.");
	}

	// We populate the state.
	state.prNumber = ref.number;
	state.owner = ref.owner;
	state.repo = ref.repo;
	state.branch = prBranch ?? (await getCurrentBranch(pi)) ?? `pr-${ref.number}`;

	const reviewsWithThreads = activeReviews.filter((r) =>
		r.threadIds.some((id) => unresolvedThreads.some((t) => t.id === id)),
	);

	sortReviewsByPriority(reviewsWithThreads);
	state.reviews = reviewsWithThreads;
	state.threads = unresolvedThreads;
	state.reviewIndex = 0;
	state.reviewIntroduced = false;
	state.threadIndexInReview = 0;

	for (const thread of unresolvedThreads) {
		state.threadStates.set(thread.id, "pending");
	}

	activate(state, pi, ctx);

	const proceed = await showSummaryPanel(ctx, {
		prNumber: ref.number,
		owner: ref.owner,
		repo: ref.repo,
		branch: state.branch,
		reviews: activeReviews,
		threads: unresolvedThreads,
		dismissedCount,
	});

	if (!proceed) {
		deactivate(state, pi, ctx);
		return textResult("PR reply cancelled.");
	}

	const activationText = briefActivation(
		ref,
		activeReviews.length,
		unresolvedThreads.length,
		dismissedCount,
	);

	const analysisContext = briefBatchAnalysis(state);

	return {
		content: [
			{
				type: "text" as const,
				text: `${activationText}\n\n${analysisContext}`,
			},
		],
		details: {
			action: "activate",
			threadCount: unresolvedThreads.length,
			reviewCount: activeReviews.length,
		},
	};
}

/** Deactivate PR reply mode. */
export async function handleDeactivate(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	const rebaseInfo = await checkDependentPRs(state, pi, ctx);

	deactivate(state, pi, ctx);

	const summary = briefCompletion(state);
	const text = rebaseInfo ? `${summary}\n\n${rebaseInfo}` : summary;

	return textResult(text);
}

/** Generate analysis: LLM provides batch analysis of all threads. */
export async function handleGenerateAnalysis(
	state: PRReplyState,
	pi: ExtensionAPI,
	analyses: Array<{
		thread_id: string;
		recommendation: string;
		analysis: string;
	}> | null,
	reviewerAnalyses: Array<{ reviewer: string; assessment: string }> | null,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active. Call 'activate' first.");
	}

	if (analyses) {
		for (const a of analyses) {
			const rec = isRecommendation(a.recommendation)
				? a.recommendation
				: "pass";
			state.threadAnalyses.set(a.thread_id, {
				recommendation: rec,
				analysis: a.analysis,
			});
		}
	}

	if (reviewerAnalyses) {
		for (const ra of reviewerAnalyses) {
			state.reviewerAnalyses.set(ra.reviewer, {
				assessment: ra.assessment,
			});
		}
	}

	persist(state, pi);

	const analyzed = state.threadAnalyses.size;
	const total = state.threads.length;

	return {
		content: [
			{
				type: "text" as const,
				text:
					`Analysis received for ${analyzed}/${total} threads. ` +
					"Call pr_reply with action 'review' to show the workspace.",
			},
		],
		details: {
			action: "generate-analysis",
			analyzed,
			total,
		},
	};
}

/** Review workspace: show the reviewer-tab workspace panel. */
export async function handleReviewWorkspace(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active. Call 'activate' first.");
	}

	if (state.threads.length === 0) {
		return textResult("No threads to review.");
	}

	refreshUI(state, ctx);

	const result = await showReplyWorkspace(ctx, state);

	persist(state, pi);
	refreshUI(state, ctx);

	if (!result) {
		return textResult(
			"Workspace dismissed. Call 'review' to reopen, or 'deactivate' to finish.",
		);
	}

	if (result.action === "redirect") {
		const thread = result.threadId
			? state.threads.find((t) => t.id === result.threadId)
			: null;
		const location = thread ? `${thread.file}:${thread.line}` : "general";

		return {
			content: [
				{
					type: "text" as const,
					text:
						`User feedback on ${location}:\n\n${result.note}\n\n` +
						"Interpret the feedback and call the appropriate action " +
						"(implement, reply, or pass with the thread_id), " +
						"then call 'review' to reopen the workspace.",
				},
			],
			details: { action: "review", redirected: true },
		};
	}

	// The user selected a thread, so we show the full-context gate.
	if (result.action === "open") {
		const thread = state.threads.find((t) => t.id === result.threadId);
		if (!thread) {
			return textResult("Thread not found. Call 'review' to reopen.");
		}

		state.currentThreadId = result.threadId;
		const review = state.reviews.find((r) => r.threadIds.includes(thread.id));
		const contextLine = thread.line || thread.originalLine || 0;
		const codeContext =
			contextLine > 0
				? await readCodeContext(pi, thread.file, contextLine)
				: null;

		// We build the recommendation from the batch analysis.
		const analysis = state.threadAnalyses.get(thread.id);
		const recommendation = analysis?.analysis ?? "";

		const progressLine = briefProgress(state);

		// We show the full-context thread gate.
		const choice = await showThreadGate(
			ctx,
			thread,
			review,
			codeContext,
			recommendation,
			progressLine,
		);

		refreshUI(state, ctx);

		const redirectContext = buildAnalysisPrompt(
			thread,
			review ?? state.reviews[0],
			codeContext?.source ?? null,
			null,
		);

		return applyThreadChoice(
			state,
			pi,
			choice,
			thread,
			contextLine,
			redirectContext,
		);
	}

	// Pass is handled inline in the workspace.
	if (result.action === "pass") {
		const thread = state.threads.find((t) => t.id === result.threadId);
		if (thread) {
			state.threadStates.set(thread.id, "passed");
			persist(state, pi);
		}
		return textResult("Thread passed. Call 'review' to reopen the workspace.");
	}

	return textResult("Action applied. Call 'review' to reopen the workspace.");
}

/**
 * Advance to the next item in the review → thread cascade.
 *
 * Navigation order:
 *   1. Reviews sorted by priority (CHANGES_REQUESTED → COMMENTED → APPROVED)
 *   2. Within each review, threads sorted by file then line
 *   3. When entering a new review, return review summary
 *   4. When within a review, return next thread data
 */
export async function handleNext(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	while (state.reviewIndex < state.reviews.length) {
		const review = state.reviews[state.reviewIndex];
		if (!review) break;

		// New review: return its summary for analysis
		if (!state.reviewIntroduced) {
			const reviewThreads = threadsForReview(review, state.threads);
			const pendingThreads = reviewThreads.filter(
				(t) => state.threadStates.get(t.id) === "pending",
			);

			if (pendingThreads.length === 0) {
				state.reviewIndex++;
				continue;
			}

			state.reviewIntroduced = true;
			state.threadIndexInReview = 0;
			refreshUI(state, ctx);
			persist(state, pi);

			return {
				content: [
					{
						type: "text" as const,
						text: briefReviewSummary(review, pendingThreads),
					},
				],
				details: {
					action: "review-summary",
					reviewId: review.id,
					reviewer: review.author,
				},
			};
		}

		// Within a review: find next pending thread
		const reviewThreads = threadsForReview(review, state.threads);
		const nextThread = findNextPendingInReview(state, reviewThreads);

		if (!nextThread) {
			state.reviewIndex++;
			state.reviewIntroduced = false;
			state.threadIndexInReview = 0;
			continue;
		}

		state.threadIndexInReview = reviewThreads.indexOf(nextThread);
		refreshUI(state, ctx);
		persist(state, pi);

		// Re-fetch comments for freshness
		if (state.owner && state.repo && state.prNumber) {
			await refreshThreadComments(
				pi,
				{ owner: state.owner, repo: state.repo, number: state.prNumber },
				nextThread,
			);
			if (nextThread.isResolved) {
				state.threadStates.set(nextThread.id, "passed");
				persist(state, pi);
				return handleNext(state, pi, ctx);
			}
		}

		const contextLine = nextThread.line || nextThread.originalLine || 0;
		const codeContext =
			contextLine > 0
				? await readCodeContext(pi, nextThread.file, contextLine)
				: null;
		const planContext = findPlanContext(ctx.cwd, nextThread.file);

		const analysisContext = buildAnalysisPrompt(
			nextThread,
			review,
			codeContext?.source ?? null,
			planContext,
		);

		const progressLine = briefProgress(state);

		return {
			content: [
				{
					type: "text" as const,
					text: briefThread(progressLine, analysisContext),
				},
			],
			details: {
				action: "next",
				threadId: nextThread.id,
				file: nextThread.file,
				line: contextLine,
			},
		};
	}

	// All reviews exhausted
	return textResult(
		"All reviews and threads addressed. Call pr_reply with action 'deactivate' to finish.",
	);
}

/** Show the review overview panel with the LLM's analysis. */
export async function handleReview(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	analysis: string,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	const review = state.reviews[state.reviewIndex];
	if (!review) {
		return textResult("No active review. Call 'next' first.");
	}

	const pendingThreads = threadsForReview(review, state.threads).filter(
		(t) => state.threadStates.get(t.id) === "pending",
	);

	const proceed = await showReviewOverviewPanel(
		ctx,
		review,
		pendingThreads,
		analysis,
	);

	if (!proceed) {
		for (const t of pendingThreads) {
			state.threadStates.set(t.id, "passed");
		}
		persist(state, pi);
		return textResult(
			`Passed review from ${review.author} (${pendingThreads.length} threads). ` +
				"Call 'next' to continue.",
		);
	}

	return textResult(
		`Review from ${review.author} acknowledged. ` +
			`${pendingThreads.length} thread${pendingThreads.length !== 1 ? "s" : ""} to review. ` +
			"Call 'next' to start.",
	);
}

/** Show the thread decision gate with the LLM's recommendation. */
export async function handleShow(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	recommendation: string,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	const thread = currentThread(state);
	if (!thread) {
		return textResult("No current thread. Call 'next' first.");
	}

	// Hide the widget while the prompt is up so they don't overlap
	ctx.ui.setWidget("pr-reply-detail", undefined);

	const review = state.reviews.find((r) => r.threadIds.includes(thread.id));
	const contextLine = thread.line || thread.originalLine || 0;
	const progressLine = briefProgress(state);

	const codeContext =
		contextLine > 0
			? await readCodeContext(pi, thread.file, contextLine)
			: null;

	const redirectContext = buildAnalysisPrompt(
		thread,
		review ?? state.reviews[0],
		codeContext?.source ?? null,
		null,
	);

	const choice = await showThreadGate(
		ctx,
		thread,
		review,
		codeContext,
		recommendation,
		progressLine,
	);

	// We restore the widget after the prompt closes.
	refreshUI(state, ctx);

	return applyThreadChoice(
		state,
		pi,
		choice,
		thread,
		contextLine,
		redirectContext,
	);
}

/** Mark current thread for implementation and provide context. */
export async function handleImplement(
	state: PRReplyState,
	pi: ExtensionAPI,
	useTDD?: boolean,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	const thread = currentThread(state);
	if (!thread) {
		return textResult("No current thread. Call 'next' first.");
	}

	await recordImplementationStart(state, pi);
	state.threadStates.set(thread.id, "implementing");

	if (useTDD) {
		beginTDDImplementation(state, thread);
		persist(state, pi);

		return textResult(
			"Thread marked for TDD implementation.\n\n" +
				`${buildImplementationContext(thread)}\n\n` +
				"Start TDD mode with tdd_phase action 'start'. " +
				"When TDD is done, call pr_reply with action 'done' " +
				"and a reply_body to post.",
		);
	}

	persist(state, pi);

	return textResult(
		"Thread marked for direct implementation.\n\n" +
			`${buildImplementationContext(thread)}\n\n` +
			"Make the necessary changes, run tests, and commit. " +
			"Then call pr_reply with action 'done' and a reply_body to post.",
	);
}

/** Post a reply to the current thread (no code changes). */
export async function handleReplyAction(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	replyBody: string | null,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	const thread = currentThread(state);
	if (!thread) {
		return textResult("No current thread. Call 'next' first.");
	}

	if (!replyBody) {
		return textResult("Provide reply_body with the text to post as a reply.");
	}

	return reviewAndPostReply(state, pi, ctx, thread, replyBody);
}

/**
 * Mark implementation as done: collect commits, post reply.
 * Called after the LLM has made changes and committed.
 */
export async function handleDone(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	replyBody: string | null,
) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	const thread = currentThread(state);
	if (!thread) {
		return textResult("No current thread.");
	}

	const commits = await collectImplementationCommits(state, pi);
	linkCommitsToThread(state, thread.id, commits);

	if (!replyBody && commits.length > 0) {
		const guidance = buildReplyGuidance(thread, commits);
		return textResult(
			`Found ${commits.length} commit${commits.length !== 1 ? "s" : ""}.\n\n` +
				`${guidance}\n\n` +
				"Call pr_reply with action 'done' again, this time with a reply_body.",
		);
	}

	if (replyBody) {
		const replyResult = await reviewAndPostReply(
			state,
			pi,
			ctx,
			thread,
			replyBody,
		);

		const replyDetails = replyResult.details as { action?: string } | undefined;
		if (replyDetails?.action !== "replied") {
			state.threadStates.set(thread.id, "addressed");
			persist(state, pi);
			return replyResult;
		}
	} else {
		state.threadStates.set(thread.id, "addressed");
	}

	state.awaitingTDDCompletion = false;
	state.tddThreadId = null;
	state.implementationStartSHA = null;
	persist(state, pi);

	const commitInfo =
		commits.length > 0
			? `${commits.length} commit${commits.length !== 1 ? "s" : ""} linked.`
			: "No new commits detected.";

	const reAnalyze = briefReAnalyze(state);

	return {
		content: [
			{
				type: "text" as const,
				text: `Thread done. ${commitInfo}\n\n${reAnalyze}`,
			},
		],
		details: {
			action: "done",
			threadId: thread.id,
			commits: shortSHAs(commits),
		},
	};
}

/** Pass the current thread (reviewed, moving on). */
export function handlePass(state: PRReplyState, pi: ExtensionAPI) {
	if (!state.enabled) {
		return textResult("PR reply mode is not active.");
	}

	const thread = currentThread(state);
	if (!thread) {
		return textResult("No current thread. Call 'next' first.");
	}

	state.threadStates.set(thread.id, "passed");
	persist(state, pi);

	return textResult("Thread passed. Call 'next' to continue.");
}

/** Map the user's gate choice to a tool result for the LLM. */
function applyThreadChoice(
	state: PRReplyState,
	pi: ExtensionAPI,
	choice: ThreadGateChoice,
	thread: Thread,
	contextLine: number,
	analysisContext: string,
) {
	if (!choice) {
		return textResult(
			"Thread gate cancelled. Call pr_reply with action 'next' to continue.",
		);
	}

	switch (choice.action) {
		case "redirect":
			return {
				content: [
					{
						type: "text" as const,
						text: briefRedirect(
							thread.file,
							contextLine,
							choice.feedback,
							analysisContext,
						),
					},
				],
				details: { action: "next", redirected: true, threadId: thread.id },
			};

		case "pass": {
			state.threadStates.set(thread.id, "passed");
			persist(state, pi);
			return textResult(
				"Thread passed. Call pr_reply with action 'next' to continue.",
			);
		}

		case "reply":
			return {
				content: [
					{
						type: "text" as const,
						text: briefReplyChoice(thread.file, contextLine, analysisContext),
					},
				],
				details: { action: "next", chosen: "reply", threadId: thread.id },
			};

		case "implement":
			return {
				content: [
					{
						type: "text" as const,
						text: briefImplementChoice(
							thread.file,
							contextLine,
							analysisContext,
						),
					},
				],
				details: {
					action: "next",
					chosen: "implement",
					threadId: thread.id,
				},
			};
	}
}

/**
 * Review a reply via approve/reject/redirect, then post to GitHub.
 */
async function reviewAndPostReply(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	thread: Thread,
	draftReply: string,
) {
	if (!state.owner || !state.repo || !state.prNumber) {
		return textResult("Missing PR context.");
	}

	const topComment = thread.comments.find((c) => c.inReplyTo === null);
	if (!topComment) {
		return textResult("Cannot find original comment to reply to.");
	}

	const reviewResult = await showReplyReview(ctx, thread, draftReply);

	if (!reviewResult.approved) {
		return {
			content: [{ type: "text" as const, text: reviewResult.reason }],
			details: { action: "reply-rejected" },
		};
	}

	// Push any unpushed commits before posting so the SHAs resolve on GitHub
	await pushIfNeeded(pi);

	const ref: PRReference = {
		owner: state.owner,
		repo: state.repo,
		number: state.prNumber,
	};

	try {
		await postReply(pi, ref, topComment.databaseId, draftReply);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`Failed to post reply: ${msg}`);
	}

	state.threadStates.set(thread.id, "replied");
	persist(state, pi);

	const reAnalyze = briefReAnalyze(state);

	return {
		content: [
			{
				type: "text" as const,
				text: `Reply posted.\n\n${reAnalyze}`,
			},
		],
		details: { action: "replied", threadId: thread.id },
	};
}

/**
 * Handle a non-current repo resolution: either the repo was
 * opened in a new tab, the tab failed to open, or the repo
 * wasn't found on disk.
 */
function handleRepoResult(
	ctx: ExtensionContext,
	result: Exclude<
		import("../lib/github/repo-discovery.js").RepoResolution,
		{ status: "current" }
	>,
	ref: PRReference,
) {
	switch (result.status) {
		case "opened-tab":
			ctx.ui.notify(
				`Opened new tab in ${result.repoPath} for PR #${ref.number}.`,
				"success",
			);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`PR #${ref.number} belongs to ${ref.owner}/${ref.repo}, which is a different repository. ` +
							`A new terminal tab has been opened at ${result.repoPath} with a pi session ` +
							`handling the PR reply workflow for #${ref.number}. ` +
							"Do NOT call pr_reply again in this session: " +
							"the new tab has all the context it needs. This task is complete.",
					},
				],
				details: { openedTab: true, repoPath: result.repoPath },
			};

		case "open-failed":
			return textResult(
				`Found ${ref.owner}/${ref.repo} at ${result.repoPath} but could not open a new tab. ` +
					`The user should run: cd ${result.repoPath} && pi "respond to reviews on ${ref.owner}/${ref.repo}#${ref.number}"`,
			);

		case "not-found":
			return textResult(
				`Repository ${ref.owner}/${ref.repo} was not found on disk. ` +
					"Ask the user where the repository is located.",
			);
	}
}

/**
 * Walk the dependency chain and offer to rebase dependent PRs.
 * Returns rebase instructions for the LLM, or null if nothing to do.
 */
async function checkDependentPRs(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<string | null> {
	if (!state.owner || !state.repo || !state.branch) return null;

	const chain = await walkDependencyChain(
		pi,
		state.owner,
		state.repo,
		state.branch,
	);
	if (chain.length === 0) return null;

	const choice = await showRebasePanel(ctx, chain);

	if (choice === "rebase") {
		return briefRebaseApproved(chain);
	}

	return null;
}

/**
 * Recursively find all PRs in the dependency chain.
 * Returns them in rebase order (closest dependent first).
 */
async function walkDependencyChain(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	branch: string,
): Promise<DependentPR[]> {
	const chain: DependentPR[] = [];
	const visited = new Set<string>();
	let currentBranch = branch;

	while (true) {
		if (visited.has(currentBranch)) break;
		visited.add(currentBranch);

		const dependentNumbers = await findDependentPRs(
			pi,
			owner,
			repo,
			currentBranch,
		);
		if (dependentNumbers.length === 0) break;

		const info = await fetchPRInfo(pi, owner, repo, dependentNumbers[0]);
		chain.push(info);
		currentBranch = info.branch;
	}

	return chain;
}

/** Fetch basic info about a PR for the dependency chain. */
async function fetchPRInfo(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<DependentPR> {
	const result = await pi.exec("gh", [
		"pr",
		"view",
		String(prNumber),
		"--repo",
		`${owner}/${repo}`,
		"--json",
		"number,title,headRefName",
	]);

	if (result.code === 0) {
		try {
			const data = JSON.parse(result.stdout);
			return {
				number: data.number ?? prNumber,
				title: data.title ?? `PR #${prNumber}`,
				branch: data.headRefName ?? "unknown",
			};
		} catch {
			/* Parse failure: fall through to default */
		}
	}

	return { number: prNumber, title: `PR #${prNumber}`, branch: "unknown" };
}
