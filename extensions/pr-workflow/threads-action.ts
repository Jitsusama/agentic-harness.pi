/**
 * Action layer for the threads sub-pipeline.
 *
 * Three actions: load threads (fetch + index), reply to a
 * thread by display index, resolve a thread by display
 * index. Each guards on the obvious preconditions (PR
 * loaded; threads fetched; index in range) and surfaces a
 * clear `error` message when the user has skipped a step.
 *
 * Dispatch is injected as a function so tests can run
 * without a real GitHub round-trip.
 */

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { PrWorkflowState, ThreadsSnapshot } from "./state.js";
import type { ReviewThread } from "./threads.js";

/** Result tag every action returns. */
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Fetcher: round-trip a thread list for a PR. */
export type ThreadsFetcher = (
	reference: PRReference,
) => Promise<ReviewThread[]>;

/** Sender: post a reply to a thread. Returns the new comment URL. */
export type ThreadReplySender = (
	threadId: string,
	body: string,
) => Promise<string>;

/** Resolver: resolve a thread. Returns the new resolved state. */
export type ThreadResolver = (threadId: string) => Promise<boolean>;

/** Fetch the PR's review threads and store them on state. */
export async function loadThreadsAction(input: {
	state: PrWorkflowState;
	fetcher: ThreadsFetcher;
	now?: () => string;
}): Promise<Result<{ snapshot: ThreadsSnapshot }>> {
	const { state, fetcher } = input;
	if (state.pr === null) {
		return { ok: false, error: "Load a PR before fetching threads." };
	}
	let threads: ReviewThread[];
	try {
		threads = await fetcher(state.pr.reference);
	} catch (err) {
		return {
			ok: false,
			error: `Failed to fetch threads: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const snapshot: ThreadsSnapshot = {
		prNumber: state.pr.reference.number,
		fetchedAt: (input.now ?? (() => new Date().toISOString()))(),
		threads,
	};
	state.threads = snapshot;
	return { ok: true, snapshot };
}

/**
 * Render the current threads snapshot as text.
 *
 * Threads display 1-based and prefixed `[T1]`, `[T2]`. Each
 * thread shows its location (file:line or `(PR-level)`),
 * resolved / outdated flags, and the first comment's author
 * + body excerpt. Reply targets the display index.
 */
export function formatThreadsView(state: PrWorkflowState): string {
	if (state.threads === null) {
		return [
			"No review threads fetched yet for this PR.",
			"Run action=threads to fetch.",
		].join("\n");
	}
	const { threads, prNumber } = state.threads;
	if (threads.length === 0) {
		return `PR #${prNumber} has zero review threads.`;
	}
	const lines: string[] = [`Review threads on PR #${prNumber}:`, ""];
	for (let i = 0; i < threads.length; i += 1) {
		const t = threads[i];
		const flags: string[] = [];
		if (t.isResolved) {
			flags.push("resolved");
		}
		if (t.isOutdated) {
			flags.push("outdated");
		}
		const flagText = flags.length > 0 ? ` (${flags.join(", ")})` : "";
		const location =
			t.kind === "review-level"
				? "(review-level)"
				: t.path === null
					? "(PR-level)"
					: t.line === null
						? t.path
						: `${t.path}:${t.line}`;
		lines.push(`[T${i + 1}] ${location}${flagText}`);
		const first = t.comments[0];
		if (first !== undefined) {
			lines.push(`  @${first.author}: ${truncate(first.body, MAX_EXCERPT)}`);
		}
		if (t.comments.length > 1) {
			lines.push(`  (+${t.comments.length - 1} more reply)`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

const MAX_EXCERPT = 160;

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) {
		return collapsed;
	}
	return `${collapsed.slice(0, max - 1)}\u2026`;
}

/** Post a reply to a thread, looked up by 1-based display index. */
export async function replyToThreadAction(input: {
	state: PrWorkflowState;
	index: number;
	body: string;
	sender: ThreadReplySender;
}): Promise<Result<{ url: string }>> {
	const { state, index, body, sender } = input;
	const lookup = lookupThread(state, index);
	if (!lookup.ok) {
		return lookup;
	}
	if (lookup.thread.kind === "review-level") {
		return {
			ok: false,
			error:
				"Review-level comments don't support inline replies. " +
				"Post a new top-level comment instead.",
		};
	}
	if (body.trim().length === 0) {
		return { ok: false, error: "Reply body is empty." };
	}
	let url: string;
	try {
		url = await sender(lookup.thread.id, body);
	} catch (err) {
		return {
			ok: false,
			error: `Failed to post reply: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { ok: true, url };
}

/** Resolve a thread, looked up by 1-based display index. */
export async function resolveThreadAction(input: {
	state: PrWorkflowState;
	index: number;
	resolver: ThreadResolver;
}): Promise<Result<{ isResolved: boolean }>> {
	const { state, index, resolver } = input;
	const lookup = lookupThread(state, index);
	if (!lookup.ok) {
		return lookup;
	}
	if (lookup.thread.kind === "review-level") {
		return {
			ok: false,
			error: "Review-level comments can't be resolved.",
		};
	}
	let isResolved: boolean;
	try {
		isResolved = await resolver(lookup.thread.id);
	} catch (err) {
		return {
			ok: false,
			error: `Failed to resolve thread: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { ok: true, isResolved };
}

function lookupThread(
	state: PrWorkflowState,
	index: number,
): { ok: true; thread: ReviewThread } | { ok: false; error: string } {
	if (state.threads === null) {
		return {
			ok: false,
			error: "No threads fetched. Run action=threads first.",
		};
	}
	if (!Number.isInteger(index) || index < 1) {
		return {
			ok: false,
			error: `Thread index must be a positive integer. Got ${index}.`,
		};
	}
	const thread = state.threads.threads[index - 1];
	if (thread === undefined) {
		return {
			ok: false,
			error: `Thread index ${index} is out of range (have ${state.threads.threads.length}).`,
		};
	}
	return { ok: true, thread };
}
