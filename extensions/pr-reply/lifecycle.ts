/**
 * PR Reply lifecycle — activate, deactivate, persist, restore,
 * and UI status display.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getLastEntry } from "../lib/state.js";
import {
	type PRReplyState,
	type Review,
	type Thread,
	type ThreadState,
	threadsForReview,
} from "./state.js";

/** Status display label for PR reply mode. */
const STATUS_EMOJI = "💬";

/** Persist key for session history entries. */
const PERSIST_KEY = "pr-reply";

/** Update status line and widget to reflect current state. */
function updateUI(state: PRReplyState, ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setStatus(PERSIST_KEY, undefined);
		ctx.ui.setWidget("pr-reply-detail", undefined);
		return;
	}

	const prRef = state.prNumber ? `#${state.prNumber}` : "?";
	ctx.ui.setStatus(PERSIST_KEY, `${STATUS_EMOJI} PR ${prRef}`);

	const review = state.reviews[state.reviewIndex];
	if (!review) {
		ctx.ui.setWidget("pr-reply-detail", undefined);
		return;
	}

	const reviewThreads = threadsForReview(review, state.threads);
	const thread = reviewThreads[state.threadIndexInReview];

	const totalReviews = state.reviews.length;
	const reviewProgress = `Review ${state.reviewIndex + 1}/${totalReviews}`;
	const done = countDone(state);
	const totalThreads = state.threads.length;

	let detail: string;
	if (thread) {
		const threadProgress = `Thread ${state.threadIndexInReview + 1}/${reviewThreads.length}`;
		detail = `${reviewProgress} (${review.author}) • ${threadProgress} • ${thread.file}:${thread.line} • ${review.state} [${done}/${totalThreads} total]`;
	} else {
		detail = `${reviewProgress} (${review.author}) • ${review.state} [${done}/${totalThreads} total]`;
	}

	ctx.ui.setWidget("pr-reply-detail", (_tui, theme) => ({
		render(width: number): string[] {
			const truncated = truncateToWidth(detail, width);
			const text = theme.fg("dim", truncated);
			const pad = Math.max(0, width - visibleWidth(truncated));
			return [`${" ".repeat(pad)}${text}`];
		},
	}));
}

/** Count threads that are replied, addressed, or skipped. */
function countDone(state: PRReplyState): number {
	let count = 0;
	for (const [, value] of state.threadStates) {
		if (value === "replied" || value === "addressed" || value === "skipped") {
			count++;
		}
	}
	return count;
}

/** Enter PR reply mode for a specific PR. */
export function activate(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (state.enabled) return;
	state.enabled = true;
	updateUI(state, ctx);
	persist(state, pi);
}

/** Exit PR reply mode and clear state. */
export function deactivate(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (!state.enabled) return;
	state.enabled = false;
	updateUI(state, ctx);
	persist(state, pi);
}

/** Toggle PR reply mode on or off. */
export function toggle(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (state.enabled) {
		deactivate(state, pi, ctx);
		ctx.ui.notify("PR reply mode off.");
	} else {
		activate(state, pi, ctx);
		ctx.ui.notify("PR reply mode on.");
	}
}

/**
 * Refresh the UI to reflect state changes
 * (e.g. after advancing to the next thread).
 */
export function refreshUI(state: PRReplyState, ctx: ExtensionContext): void {
	updateUI(state, ctx);
}

/** Save state to session history. */
export function persist(state: PRReplyState, pi: ExtensionAPI): void {
	pi.appendEntry(PERSIST_KEY, {
		enabled: state.enabled,
		prNumber: state.prNumber,
		owner: state.owner,
		repo: state.repo,
		branch: state.branch,
		reviews: state.reviews,
		threads: state.threads,
		reviewIndex: state.reviewIndex,
		reviewIntroduced: state.reviewIntroduced,
		threadIndexInReview: state.threadIndexInReview,
		threadStates: Array.from(state.threadStates.entries()),
		threadCommits: Array.from(state.threadCommits.entries()),
		awaitingTDDCompletion: state.awaitingTDDCompletion,
		tddThreadId: state.tddThreadId,
		implementationStartSHA: state.implementationStartSHA,
	});
}

/** Restore state from session history on startup. */
export function restore(state: PRReplyState, ctx: ExtensionContext): void {
	const saved = getLastEntry<{
		enabled?: boolean;
		prNumber?: number;
		owner?: string;
		repo?: string;
		branch?: string;
		reviews?: Review[];
		threads?: Thread[];
		reviewIndex?: number;
		reviewIntroduced?: boolean;
		threadIndexInReview?: number;
		threadStates?: Array<[string, ThreadState]>;
		threadCommits?: Array<[string, string[]]>;
		awaitingTDDCompletion?: boolean;
		tddThreadId?: string | null;
		implementationStartSHA?: string | null;
	}>(ctx, PERSIST_KEY);

	if (!saved) return;

	state.enabled = saved.enabled ?? false;
	state.prNumber = saved.prNumber ?? null;
	state.owner = saved.owner ?? null;
	state.repo = saved.repo ?? null;
	state.branch = saved.branch ?? null;
	state.reviews = saved.reviews ?? [];
	state.threads = saved.threads ?? [];
	state.reviewIndex = saved.reviewIndex ?? 0;
	state.reviewIntroduced = saved.reviewIntroduced ?? false;
	state.threadIndexInReview = saved.threadIndexInReview ?? 0;
	state.awaitingTDDCompletion = saved.awaitingTDDCompletion ?? false;
	state.tddThreadId = saved.tddThreadId ?? null;
	state.implementationStartSHA = saved.implementationStartSHA ?? null;

	if (saved.threadStates) {
		state.threadStates = new Map(saved.threadStates);
	}
	if (saved.threadCommits) {
		state.threadCommits = new Map(saved.threadCommits);
	}

	updateUI(state, ctx);
}
