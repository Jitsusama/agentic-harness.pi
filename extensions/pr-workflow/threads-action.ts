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
	state.threadsVersionSeq += 1;
	const snapshot: ThreadsSnapshot = {
		prNumber: state.pr.reference.number,
		fetchedAt: (input.now ?? (() => new Date().toISOString()))(),
		mutatedAt: null,
		version: state.threadsVersionSeq,
		threads: [...threads],
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

/**
 * Identity a reply or resolve captured when the user
 * targeted a thread. The action re-checks it against the
 * live snapshot before firing so a concurrent refetch or
 * sibling mutation can't redirect the action to a
 * different thread.
 */
export interface ThreadActionExpectation {
	readonly threadId: string;
	readonly version: number;
}

/**
 * Capture the drift guard for the thread at a 1-based
 * display index: its id plus the live snapshot version.
 * Returns undefined when no snapshot or no thread sits
 * there, so a caller can target an absent thread and let
 * the action report the out-of-range error. Callers grab
 * this before any await (a gate, a network send) and hand
 * it back to the action so a concurrent refetch can't
 * redirect the action to a different thread.
 */
export function captureThreadExpectation(
	state: PrWorkflowState,
	index: number,
): ThreadActionExpectation | undefined {
	const snapshot = state.threads;
	if (snapshot === null) return undefined;
	const thread = snapshot.threads[index - 1];
	if (thread === undefined) return undefined;
	return { threadId: thread.id, version: snapshot.version };
}

/** Post a reply to a thread, looked up by 1-based display index. */
export async function replyToThreadAction(input: {
	state: PrWorkflowState;
	index: number;
	body: string;
	sender: ThreadReplySender;
	now?: () => string;
	/** Login to attribute the locally-applied reply to. */
	author?: string;
	/** Drift guard captured when the user targeted the thread. */
	expect?: ThreadActionExpectation;
}): Promise<Result<{ url: string }>> {
	const { state, index, body, sender } = input;
	const lookup = lookupThread(state, index);
	if (!lookup.ok) {
		return lookup;
	}
	const drift = checkDrift(state, index, input.expect);
	if (drift !== null) {
		return { ok: false, error: drift };
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
	// The remote reply used the captured thread id, so it landed
	// correctly. But the snapshot may have been swapped by a
	// refetch while the send was in flight; only touch the local
	// cache when it's still the snapshot we targeted, so we never
	// poison a fresh snapshot that never saw this reply.
	if (checkDrift(state, index, input.expect) === null) {
		applyReplyLocally(
			state,
			lookup.thread.id,
			body,
			url,
			input.author,
			input.now,
		);
	}
	return { ok: true, url };
}

/**
 * Append the new comment to the in-memory snapshot so
 * `summary` and re-renders of the threads view stay
 * consistent with what the user just posted, without
 * paying for a refetch. The fetched-at timestamp stays
 * frozen; `mutatedAt` advances so downstream callers
 * can surface staleness if they care.
 */
function applyReplyLocally(
	state: PrWorkflowState,
	threadId: string,
	body: string,
	url: string,
	author: string | undefined,
	now: (() => string) | undefined,
): void {
	if (state.threads === null) return;
	const snapshot = state.threads;
	const index = snapshot.threads.findIndex((t) => t.id === threadId);
	if (index < 0) return;
	const at = (now ?? (() => new Date().toISOString()))();
	const target = snapshot.threads[index];
	snapshot.threads[index] = {
		...target,
		comments: [
			...target.comments,
			{
				id: `local-${at}-${url}`,
				author: author ?? "viewer",
				body,
				createdAt: at,
				url,
			},
		],
	};
	snapshot.mutatedAt = at;
	state.threadsVersionSeq += 1;
	snapshot.version = state.threadsVersionSeq;
}

/** Resolve a thread, looked up by 1-based display index. */
export async function resolveThreadAction(input: {
	state: PrWorkflowState;
	index: number;
	resolver: ThreadResolver;
	now?: () => string;
	/** Drift guard captured when the user targeted the thread. */
	expect?: ThreadActionExpectation;
}): Promise<Result<{ isResolved: boolean }>> {
	const { state, index, resolver } = input;
	const lookup = lookupThread(state, index);
	if (!lookup.ok) {
		return lookup;
	}
	const drift = checkDrift(state, index, input.expect);
	if (drift !== null) {
		return { ok: false, error: drift };
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
	// Only touch the local cache if the snapshot didn't get
	// swapped during the resolve round-trip (see the reply path
	// for the same reasoning).
	if (checkDrift(state, index, input.expect) === null) {
		applyResolveLocally(state, lookup.thread.id, isResolved, input.now);
	}
	return { ok: true, isResolved };
}

function applyResolveLocally(
	state: PrWorkflowState,
	threadId: string,
	isResolved: boolean,
	now: (() => string) | undefined,
): void {
	if (state.threads === null) return;
	const snapshot = state.threads;
	const index = snapshot.threads.findIndex((t) => t.id === threadId);
	if (index < 0) return;
	snapshot.threads[index] = {
		...snapshot.threads[index],
		isResolved,
	};
	snapshot.mutatedAt = (now ?? (() => new Date().toISOString()))();
	state.threadsVersionSeq += 1;
	snapshot.version = state.threadsVersionSeq;
}

/**
 * Compare the live snapshot against the identity the user
 * targeted. Returns an error message when the snapshot
 * version moved or the captured thread id no longer sits at
 * the targeted index, else null. A missing expectation skips
 * the check (legacy callers that target and act atomically).
 */
function checkDrift(
	state: PrWorkflowState,
	index: number,
	expect: ThreadActionExpectation | undefined,
): string | null {
	if (expect === undefined) return null;
	const snapshot = state.threads;
	if (snapshot === null) {
		return "Threads were cleared since you targeted this reply. Re-run action=threads.";
	}
	if (snapshot.version !== expect.version) {
		return (
			`Threads changed since you targeted [T${index}] ` +
			`(snapshot v${expect.version} → v${snapshot.version}). ` +
			"Re-run action=threads and retry."
		);
	}
	const atIndex = snapshot.threads[index - 1];
	if (atIndex === undefined || atIndex.id !== expect.threadId) {
		return (
			`Thread [T${index}] no longer points at the thread you targeted. ` +
			"Re-run action=threads and retry."
		);
	}
	return null;
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
