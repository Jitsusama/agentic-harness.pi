/**
 * LLM briefings: pure functions that build text summaries
 * for the agent to reason about.
 *
 * Each function takes review/thread data and returns a string.
 * No side effects, no state mutation, no UI.
 */

import type { PRReference } from "./api/github.js";
import type { PRReplyState, ReceivedReview, ReviewThread } from "./state.js";
import { threadsForReview } from "./state.js";

/** Count threads in a given state. */
function countByState(state: PRReplyState, threadState: string): number {
	let count = 0;
	for (const [, value] of state.threadStates) {
		if (value === threadState) count++;
	}
	return count;
}

/** Summary text returned after activation. */
export function activationBriefing(
	ref: PRReference,
	reviewCount: number,
	threadCount: number,
	dismissedCount: number,
): string {
	const parts = [
		`PR reply mode activated for ${ref.owner}/${ref.repo}#${ref.number}.`,
		`${threadCount} unresolved thread${threadCount !== 1 ? "s" : ""} across ${reviewCount} review${reviewCount !== 1 ? "s" : ""}.`,
	];

	if (dismissedCount > 0) {
		parts.push(
			`${dismissedCount} dismissed review${dismissedCount !== 1 ? "s" : ""} filtered.`,
		);
	}

	parts.push(
		"Call pr_reply with action 'generate-analysis' providing your analysis of all threads.",
	);

	return parts.join(" ");
}

/**
 * Batch analysis briefing: comprehensive thread context for
 * the LLM to analyze all threads at once.
 */
export function batchAnalysisBriefing(state: PRReplyState): string {
	const parts: string[] = [];

	parts.push("## Review Threads for Batch Analysis");
	parts.push("");

	for (const review of state.reviews) {
		const reviewThreads = threadsForReview(review, state.threads);
		if (reviewThreads.length === 0) continue;

		parts.push(`### Review from ${review.author} (${review.state})`);
		if (review.body) {
			parts.push(review.body);
			parts.push("");
		}

		for (const thread of reviewThreads) {
			parts.push(
				`#### Thread: ${thread.file}:${thread.line} (id: ${thread.id})`,
			);
			if (thread.isOutdated) {
				parts.push("⚠️ **Outdated**: the code has changed since this comment.");
			}

			for (const comment of thread.comments) {
				const role = comment.inReplyTo === null ? "[Original]" : "[Reply]";
				parts.push(`**${role}** ${comment.author}:`);
				parts.push(comment.body);
				parts.push("");
			}
		}
	}

	parts.push("### Instructions");
	parts.push("");
	parts.push(
		"Analyze all threads, then call pr_reply with action 'generate-analysis' providing:",
	);
	parts.push("");
	parts.push(
		"1. **`analyses`**: for each thread, a recommendation (implement/reply/pass) " +
			"and analysis text explaining your reasoning",
	);
	parts.push(
		"2. **`reviewer_analyses`**: for each reviewer, a brief character assessment " +
			"(thorough, nitpicky, collaborative, blocking, etc.)",
	);
	parts.push("");
	parts.push(
		"Be critical: don't just agree with every reviewer. Evaluate whether each " +
			"suggestion actually improves the code.",
	);

	return parts.join("\n");
}

/** Progress indicator for thread navigation headers. */
export function progressBriefing(state: PRReplyState): string {
	const review = state.reviews[state.reviewIndex];
	const reviewLabel = review
		? `Review ${state.reviewIndex + 1}/${state.reviews.length} (${review.author})`
		: `Review ?/${state.reviews.length}`;

	const done =
		countByState(state, "replied") +
		countByState(state, "addressed") +
		countByState(state, "passed");
	const total = state.threads.length;

	return `[PR #${state.prNumber} • ${reviewLabel} • ${done}/${total} threads done]`;
}

/** Summary of a new review for the LLM to analyze. */
export function reviewSummaryBriefing(
	review: ReceivedReview,
	pendingThreads: ReviewThread[],
): string {
	const parts: string[] = [];
	parts.push(`## Review from ${review.author}`);
	parts.push(`**State**: ${review.state}`);
	parts.push(`**Submitted**: ${review.submittedAt}`);
	parts.push(`**Threads**: ${pendingThreads.length}`);
	if (review.body) {
		parts.push("");
		parts.push("### Review Comment");
		parts.push(review.body);
	}
	parts.push("");
	parts.push("### Threads in This Review");
	for (const t of pendingThreads) {
		const snippet = t.comments[0]?.body.slice(0, 60).replace(/\n/g, " ") ?? "";
		const ellipsis = (t.comments[0]?.body.length ?? 0) > 60 ? "…" : "";
		parts.push(`  • ${t.file}:${t.line}: ${snippet}${ellipsis}`);
	}
	parts.push("");
	parts.push(
		"Analyze the character of this review: is it thorough, nitpicky, " +
			"collaborative, blocking? Then call pr_reply with action 'review' " +
			"and your analysis as the 'analysis' parameter.",
	);

	return parts.join("\n");
}

/** Thread context for the LLM, with analysis instructions. */
export function threadBriefing(
	progressLine: string,
	analysisContext: string,
): string {
	return (
		`${progressLine}\n\n${analysisContext}\n\n` +
		"Analyze this thread critically. Don't just agree with the reviewer: evaluate " +
		"whether their suggestion actually improves the code. If the user already " +
		"addressed the feedback or pushed back with good reasoning, say so. " +
		"Then call pr_reply with action 'show' and your recommendation " +
		"(as the 'analysis' parameter)."
	);
}

/** Completion summary when deactivating. */
export function completionBriefing(state: PRReplyState): string {
	const total = state.threads.length;
	const replied = countByState(state, "replied");
	const addressed = countByState(state, "addressed");
	const passed = countByState(state, "passed");

	return (
		`PR reply complete for #${state.prNumber}. ` +
		`${replied} replied, ${addressed} addressed, ` +
		`${passed} passed ` +
		`out of ${total} thread${total !== 1 ? "s" : ""}.`
	);
}

/** Thread choice result: user redirected with feedback. */
export function redirectBriefing(
	file: string,
	contextLine: number,
	feedback: string,
	analysisContext: string,
): string {
	return (
		`User feedback on thread ${file}:${contextLine}:\n\n` +
		`${feedback}\n\n` +
		`Thread context:\n${analysisContext}\n\n` +
		"Interpret the user's feedback and call pr_reply with the appropriate " +
		"action (implement, reply, or pass). If they want a reply composed, " +
		"call pr_reply with action 'reply' and a reply_body."
	);
}

/** Thread choice result: user chose to reply. */
export function replyChoiceBriefing(
	file: string,
	contextLine: number,
	analysisContext: string,
): string {
	return (
		`User chose to reply to thread on ${file}:${contextLine}.\n\n` +
		`Thread context:\n${analysisContext}\n\n` +
		"Compose a reply and call pr_reply with action 'reply' and a reply_body. " +
		"The reply should be conversational, acknowledge the feedback, and be brief."
	);
}

/** Thread choice result: user chose to implement. */
export function implementChoiceBriefing(
	file: string,
	contextLine: number,
	analysisContext: string,
): string {
	return (
		`User chose to implement changes for thread on ${file}:${contextLine}.\n\n` +
		`Thread context:\n${analysisContext}\n\n` +
		"Recommend whether to use TDD based on the change scope. " +
		"Then call pr_reply with action 'implement' (and use_tdd if appropriate). " +
		"After making changes and committing, call pr_reply with action 'done' and a reply_body."
	);
}

/**
 * Re-analysis prompt: tells the LLM to re-evaluate all pending
 * threads after a state change (implementation, reply, or pass).
 */
export function reAnalyzeBriefing(state: PRReplyState): string {
	const pending = state.threads.filter(
		(t) => state.threadStates.get(t.id) === "pending",
	);

	if (pending.length === 0) {
		return "All threads addressed. Call pr_reply with action 'deactivate' to finish.";
	}

	const parts: string[] = [];
	parts.push(
		`${pending.length} thread${pending.length !== 1 ? "s" : ""} still pending. ` +
			"Code has changed: re-analyze all pending threads with fresh context.",
	);
	parts.push("");
	parts.push("Pending threads:");
	for (const t of pending) {
		const snippet = t.comments[0]?.body.slice(0, 50).replace(/\n/g, " ") ?? "";
		parts.push(`  • ${t.id}: ${t.file}:${t.line}: ${snippet}`);
	}
	parts.push("");
	parts.push(
		"Read the relevant files to check current state, then call " +
			"pr_reply with action 'generate-analysis' with updated analyses. " +
			"Then call 'review' to reopen the workspace.",
	);

	return parts.join("\n");
}

/** Rebase instructions after deactivation. */
export function rebaseApprovedBriefing(
	chain: Array<{ number: number; branch: string }>,
): string {
	const prList = chain.map((d) => `#${d.number} (${d.branch})`).join(" → ");
	return (
		`User approved rebasing the PR chain: ${prList}.\n` +
		"Rebase each branch in order onto its updated base, " +
		"then force-push each one. Handle conflicts using the rebase skill."
	);
}

/**
 * Build a context string describing what the implementation
 * should address. Used when activating TDD mode or giving
 * the LLM implementation instructions.
 */
export function buildImplementationContext(thread: ReviewThread): string {
	const parts: string[] = [];

	parts.push(`Addressing review feedback on ${thread.file}:${thread.line}`);
	parts.push("");

	for (const comment of thread.comments) {
		parts.push(`${comment.author}: ${comment.body}`);
	}

	return parts.join("\n");
}
