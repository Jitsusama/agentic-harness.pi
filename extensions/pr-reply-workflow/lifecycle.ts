/**
 * Manages the PR reply lifecycle: activation, deactivation,
 * persisting state across sessions, restoring it on return,
 * and keeping the status line up to date.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getLastEntry } from "../../lib/internal/state.js";
import {
	updateWorkflowStatus,
	type WorkflowStatusConfig,
} from "../../lib/internal/workflow-status.js";
import {
	type PRReplyState,
	type ReceivedReview,
	type ReviewThread,
	resetState,
	type ThreadState,
} from "./state.js";

/**
 * Shape of a persisted thread. Includes the status field
 * that lives on the thread object, plus a fallback for
 * sessions persisted before the migration.
 */
interface PersistedThread extends ReviewThread {
	status: ThreadState;
}

/** Shape of PR reply data written to session history. */
interface PersistedState {
	enabled?: boolean;
	prNumber?: number;
	owner?: string;
	repo?: string;
	branch?: string;
	reviews?: ReceivedReview[];
	threads?: PersistedThread[];
	/** @deprecated Separate map from before status lived on threads. */
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

/** Persist key for session history entries. */
const PERSIST_KEY = "pr-reply";

/** Widget key for the detail line above the editor. */
const WIDGET_KEY = "pr-reply-detail";

/** Shared config for status line and detail widget. */
const STATUS_CONFIG: WorkflowStatusConfig = {
	statusKey: PERSIST_KEY,
	widgetKey: WIDGET_KEY,
	label: "PR Reply",
};

/** Build the detail widget text for the current state. */
function buildDetailText(state: PRReplyState): string | null {
	if (state.threads.length === 0) return null;

	const prRef = state.prNumber ? `PR #${state.prNumber}` : "PR ?";
	const total = state.threads.length;
	const done = state.threads.filter(
		(t) =>
			t.status === "replied" ||
			t.status === "addressed" ||
			t.status === "passed",
	).length;
	const pending = total - done;

	return `${prRef} · Reply · ${done}/${total} (${done}✓ ${pending}○)`;
}

/** Update status line and detail widget to reflect current state. */
function updateUI(state: PRReplyState, ctx: ExtensionContext): void {
	updateWorkflowStatus(STATUS_CONFIG, state, ctx, () => buildDetailText(state));
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
	resetState(state);
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
	const threads: ReviewThread[] = saved.threads ?? [];

	// Backward compat: restore status from the old separate Map
	// for sessions persisted before the migration.
	if (saved.threadStates) {
		const legacyStates = new Map(saved.threadStates);
		for (const thread of threads) {
			if (!thread.status) {
				thread.status = legacyStates.get(thread.id) ?? "pending";
			}
		}
	}

	// Ensure every thread has a status (default to pending).
	for (const thread of threads) {
		if (!thread.status) {
			thread.status = "pending";
		}
	}

	state.threads = threads;
	state.awaitingTDDCompletion = saved.awaitingTDDCompletion ?? false;
	state.tddThreadId = saved.tddThreadId ?? null;
	state.implementationStartSHA = saved.implementationStartSHA ?? null;

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
