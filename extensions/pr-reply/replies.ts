/**
 * Reply utilities: prompt building for LLM-driven reply
 * composition. The LLM generates reply text as part of its
 * natural reasoning, guided by these prompt fragments.
 */

import { shortSHAs } from "./implementation.js";
import type { Thread } from "./state.js";

/**
 * Build a prompt fragment describing how to compose a reply.
 *
 * Returned as part of the 'done' action context when the LLM
 * needs to generate a reply_body for a thread that has been
 * implemented.
 */
export function buildReplyGuidance(thread: Thread, commits: string[]): string {
	const parts: string[] = [];

	parts.push("## Reply Guidelines");
	parts.push("");

	// Thread context
	const original = thread.comments.find((c) => c.inReplyTo === null);
	if (original) {
		parts.push(`Responding to ${original.author}'s comment:`);
		parts.push(`> ${original.body}`);
		parts.push("");
	}

	// Commit info
	if (commits.length > 0) {
		const shas = shortSHAs(commits);
		parts.push(`Commits addressing this: ${shas.join(", ")}`);
		parts.push("");
		parts.push("Include commit SHA(s) naturally in the reply.");
		parts.push("Do NOT list them separately.");
	}

	parts.push("");
	parts.push("Keep it brief, conversational, and acknowledge the feedback.");

	return parts.join("\n");
}
