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
import type {
	PRReplyState,
	ReceivedReview,
	ReviewThread,
	ThreadState,
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

/** Derive the current workflow phase from thread states. */
function derivePhase(state: PRReplyState): string {
	for (const [, st] of state.threadStates) {
		if (st === "implementing") return "Implementing";
	}
	for (const [, st] of state.threadStates) {
		if (st === "addressed") return "Composing Reply";
	}
	return "Browsing";
}

/**
 * Derive the current review position from workspace selection
 * or legacy navigation index.
 */
function deriveReviewPosition(state: PRReplyState): number {
	if (state.currentThreadId) {
		const thread = state.threads.find((t) => t.id === state.currentThreadId);
		if (thread) {
			const idx = state.reviews.findIndex((r) =>
				r.threadIds.includes(thread.id),
			);
			if (idx >= 0) return idx + 1;
		}
	}
	return (state.reviewIndex ?? 0) + 1;
}

/** Build the detail widget text for the current state. */
function buildDetailText(state: PRReplyState): string {
	const prRef = `PR #${state.prNumber}`;
	const phase = derivePhase(state);

	const reviewPos = deriveReviewPosition(state);
	const reviewSegment = `${reviewPos}/${state.reviews.length} reviews`;

	let replied = 0;
	let passed = 0;
	let pending = 0;
	for (const [, st] of state.threadStates) {
		if (st === "replied" || st === "addressed") replied++;
		else if (st === "passed") passed++;
		else if (st === "pending") pending++;
		// "implementing" counts as pending (in progress)
	}
	const done = replied + passed;
	const total = state.threads.length;
	const threadSegment = `${done}/${total} threads`;
	const counts = `(${replied}✓ ${passed}↩ ${pending}○)`;

	return `${prRef} · ${phase} · ${reviewSegment} · ${threadSegment} ${counts}`;
}

/** Update status line and widget to reflect current state. */
function updateUI(state: PRReplyState, ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setStatus(PERSIST_KEY, undefined);
		ctx.ui.setWidget("pr-reply-detail", undefined);
		return;
	}

	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		PERSIST_KEY,
		`${theme.fg("accent", STATUS_GLYPH)} ${theme.fg("muted", "PR Reply")}`,
	);

	const detail = buildDetailText(state);
	ctx.ui.setWidget("pr-reply-detail", (_tui, theme) => ({
		render(width: number): string[] {
			const truncated = truncateToWidth(detail, width);
			const text = theme.fg("dim", truncated);
			const pad = Math.max(0, width - visibleWidth(truncated));
			return [`${" ".repeat(pad)}${text}`];
		},
	}));
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
