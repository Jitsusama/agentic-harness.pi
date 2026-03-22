/**
 * Thread analysis: build structured context for the LLM
 * to evaluate each review thread.
 *
 * The LLM receives this context as part of the 'next' action
 * result, analyzes the thread, and presents recommendations
 * to the user.
 */

import type { ReceivedReview, ReviewThread } from "./state.js";
import { threadPriority } from "./state.js";

/**
 * Build analysis context for the LLM to evaluate a thread.
 *
 * Returns a formatted prompt fragment with the thread
 * conversation, code context, metadata, and instructions
 * for the LLM to analyze the feedback.
 */
export function buildAnalysisPrompt(
	thread: ReviewThread,
	review: ReceivedReview,
	codeContext: string | null,
	planContext: string | null,
): string {
	const parts: string[] = [];

	// Thread metadata
	parts.push("## Review Thread");
	parts.push("");
	parts.push(`**File**: \`${thread.file}:${thread.line}\``);
	parts.push(`**Reviewer**: ${review.author}`);
	parts.push(`**Review state**: ${review.state}`);
	parts.push(`**Priority**: ${threadPriority(thread)}`);

	if (thread.isOutdated) {
		parts.push(
			"**⚠️ Outdated**: The code has changed since this comment was posted.",
		);
		if (thread.originalLine) {
			parts.push(`**Original line**: ${thread.originalLine}`);
		}
	}

	// Full thread conversation
	parts.push("");
	parts.push("### Conversation");
	for (const comment of thread.comments) {
		const role = comment.inReplyTo === null ? "[Original]" : "[Reply]";
		parts.push(`**${role}** ${comment.author} (${comment.createdAt}):`);
		parts.push(comment.body);
		parts.push("");
	}

	// Code context from disk
	if (codeContext) {
		parts.push("### Code Context");
		parts.push("```");
		parts.push(codeContext);
		parts.push("```");
		parts.push("");
	}

	// Plan context
	if (planContext) {
		parts.push("### Relevant Plan Context");
		parts.push(planContext);
		parts.push("");
	}

	return parts.join("\n");
}
