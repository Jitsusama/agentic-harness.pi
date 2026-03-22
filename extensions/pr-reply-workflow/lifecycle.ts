/**
 * Manages the PR reply lifecycle: activation, deactivation,
 * persisting state across sessions, restoring it on return,
 * and keeping the status line up to date.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getLastEntry } from "../lib/state.js";
import {
	type PRReplyState,
	type ReceivedReview,
	type ReviewThread,
	type ThreadState,
	threadsForReview,
} from "./state.js";

/** Shape of PR reply data written to session history. */
interface PersistedState {
	enabled?: boolean;
	prNumber?: number;
	owner?: string;
	repo?: string;
	branch?: string;
	reviews?: ReceivedReview[];
	threads?: ReviewThread[];
	threadStates?: Array<[string, ThreadState]>;
	threadAnalyses?: Array<
		[string, { recommendation: string; analysis: string }]
	>;
	reviewerAnalyses?: Array<[string, { assessment: string }]>;
	currentThreadId?: string | null;
	workspacePosition?: {
		tabIndex: number;
		threadIndices: Array<[string, number]>;
	} | null;
	threadCommits?: Array<[string, string[]]>;
	awaitingTDDCompletion?: boolean;
	tddThreadId?: string | null;
	implementationStartSHA?: string | null;
}

/** Status glyph for PR reply mode. */
const STATUS_GLYPH = "◈";

/** Persist key for session history entries. */
const PERSIST_KEY = "pr-reply";

/** Update status line and widget to reflect current state. */
function updateUI(state: PRReplyState, ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setStatus(PERSIST_KEY, undefined);
		ctx.ui.setWidget("pr-reply-detail", undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const prRef = state.prNumber ? `#${state.prNumber}` : "?";
	ctx.ui.setStatus(
		PERSIST_KEY,
		`${theme.fg("accent", STATUS_GLYPH)} ${theme.fg("muted", `PR ${prRef}`)}`,
	);

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

/** Count threads that are replied, addressed, or passed. */
function countDone(state: PRReplyState): number {
	let count = 0;
	for (const [, value] of state.threadStates) {
		if (value === "replied" || value === "addressed" || value === "passed") {
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
		threadStates: Array.from(state.threadStates.entries()),
		threadAnalyses: Array.from(state.threadAnalyses.entries()),
		reviewerAnalyses: Array.from(state.reviewerAnalyses.entries()),
		currentThreadId: state.currentThreadId,
		workspacePosition: state.workspacePosition
			? {
					tabIndex: state.workspacePosition.tabIndex,
					threadIndices: Array.from(
						state.workspacePosition.threadIndices.entries(),
					),
				}
			: null,
		threadCommits: Array.from(state.threadCommits.entries()),
		awaitingTDDCompletion: state.awaitingTDDCompletion,
		tddThreadId: state.tddThreadId,
		implementationStartSHA: state.implementationStartSHA,
	});
}

/** Restore state from session history on startup. */
export function restore(state: PRReplyState, ctx: ExtensionContext): void {
	const saved = getLastEntry<PersistedState>(ctx, PERSIST_KEY);

	if (!saved) return;

	state.enabled = saved.enabled ?? false;
	state.prNumber = saved.prNumber ?? null;
	state.owner = saved.owner ?? null;
	state.repo = saved.repo ?? null;
	state.branch = saved.branch ?? null;
	state.reviews = saved.reviews ?? [];
	state.threads = saved.threads ?? [];
	state.awaitingTDDCompletion = saved.awaitingTDDCompletion ?? false;
	state.tddThreadId = saved.tddThreadId ?? null;
	state.implementationStartSHA = saved.implementationStartSHA ?? null;

	if (saved.threadStates) {
		state.threadStates = new Map(saved.threadStates);
	}
	if (saved.threadAnalyses) {
		state.threadAnalyses = new Map(saved.threadAnalyses);
	}
	if (saved.reviewerAnalyses) {
		state.reviewerAnalyses = new Map(saved.reviewerAnalyses);
	}
	state.currentThreadId = saved.currentThreadId ?? null;
	if (saved.workspacePosition) {
		state.workspacePosition = {
			tabIndex: saved.workspacePosition.tabIndex,
			threadIndices: new Map(saved.workspacePosition.threadIndices ?? []),
		};
	}
	if (saved.threadCommits) {
		state.threadCommits = new Map(saved.threadCommits);
	}

	updateUI(state, ctx);
}
