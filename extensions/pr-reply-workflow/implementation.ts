/**
 * Implementation coordination: manage code changes that
 * address review feedback, with or without TDD.
 *
 * Tracks HEAD before implementation starts so we can find
 * which commits were created during the process. Coordinates
 * with TDD mode by setting state flags that the index.ts
 * event handler uses to detect TDD completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReplyState, Thread } from "./state.js";

/**
 * Record the current HEAD SHA before starting implementation.
 * After implementation completes, we compare to find new commits.
 */
export async function recordImplementationStart(
	state: PRReplyState,
	pi: ExtensionAPI,
): Promise<void> {
	const result = await pi.exec("git", ["rev-parse", "HEAD"]);
	if (result.code === 0) {
		state.implementationStartSHA = result.stdout.trim();
	}
}

/**
 * Collect commits made since implementation started.
 * Returns commit SHAs in chronological order (oldest first).
 */
export async function collectImplementationCommits(
	state: PRReplyState,
	pi: ExtensionAPI,
): Promise<string[]> {
	if (!state.implementationStartSHA) return [];

	const result = await pi.exec("git", [
		"log",
		`${state.implementationStartSHA}..HEAD`,
		"--format=%H",
		"--reverse",
	]);

	if (result.code !== 0 || !result.stdout.trim()) return [];

	return result.stdout.trim().split("\n");
}

/**
 * Link collected commits to a thread and clear the
 * implementation tracking state.
 */
export function linkCommitsToThread(
	state: PRReplyState,
	threadId: string,
	commits: string[],
): void {
	if (commits.length === 0) return;

	const existing = state.threadCommits.get(threadId) ?? [];
	state.threadCommits.set(threadId, [...existing, ...commits]);
	state.implementationStartSHA = null;
}

/**
 * Prepare state for TDD-driven implementation of a thread.
 * Sets flags that the event handler monitors for TDD completion.
 */
export function beginTDDImplementation(
	state: PRReplyState,
	thread: Thread,
): void {
	state.awaitingTDDCompletion = true;
	state.tddThreadId = thread.id;
	state.threadStates.set(thread.id, "implementing");
}

/**
 * Handle TDD completion signal. Clears the awaiting flag
 * so the review loop can resume.
 */
export function handleTDDCompletion(state: PRReplyState): void {
	state.awaitingTDDCompletion = false;
	// The tddThreadId is preserved so we can link commits to it.
}

/**
 * Build a context string describing what the implementation
 * should address. Used when activating TDD mode or giving
 * the LLM implementation instructions.
 */
export function buildImplementationContext(thread: Thread): string {
	const parts: string[] = [];

	parts.push(`Addressing review feedback on ${thread.file}:${thread.line}`);
	parts.push("");

	// We include the original comment and any discussion.
	for (const comment of thread.comments) {
		parts.push(`${comment.author}: ${comment.body}`);
	}

	return parts.join("\n");
}

/**
 * Get abbreviated commit SHAs for display in replies.
 * Returns 7-character short SHAs.
 */
export function shortSHAs(commits: string[]): string[] {
	return commits.map((sha) => sha.slice(0, 7));
}

/**
 * Push to the remote if there are unpushed commits.
 * Non-fatal: replies still post if push fails, but SHAs
 * won't be clickable on GitHub until the next push.
 */
export async function pushIfNeeded(pi: ExtensionAPI): Promise<void> {
	const status = await pi.exec("git", [
		"rev-list",
		"--count",
		"@{upstream}..HEAD",
	]);

	const ahead = Number.parseInt(status.stdout.trim(), 10);
	if (Number.isNaN(ahead) || ahead === 0) return;

	await pi.exec("git", ["push"]);
	// This is non-fatal; the reply will still be posted.
}
