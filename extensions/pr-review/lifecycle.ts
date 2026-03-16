/**
 * PR Review lifecycle — activate, deactivate, persist, restore,
 * and UI status display.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getLastEntry } from "../lib/state.js";
import {
	type CommentState,
	countCommentsByState,
	type PRReviewState,
	type PreviousReview,
	type PreviousThread,
	type ReviewComment,
	type ReviewPhase,
	type ReviewVerdict,
	resetState,
} from "./state.js";

/** Status glyph for PR review mode. */
const STATUS_GLYPH = "◈";

/** Persist key for session history entries. */
const PERSIST_KEY = "pr-review";

/** Widget key for the detail line above the editor. */
const WIDGET_KEY = "pr-review-detail";

/** Build the detail widget text for the current phase. */
function buildDetailText(state: PRReviewState): string {
	const prRef = `PR #${state.prNumber ?? "?"}`;

	switch (state.phase) {
		case "gathering":
			return `${prRef} · Gathering context…`;
		case "context":
			return `${prRef} · Context summary`;
		case "description":
			return `${prRef} · Description & scope review`;
		case "analyzing":
			return `${prRef} · Deep analysis…`;
		case "files": {
			const fileCount = state.context?.diffFiles.length ?? 0;
			const accepted = countCommentsByState(state, "accepted");
			const total = state.comments.length;
			return `${prRef} · file-review · ${state.fileIndex + 1}/${fileCount} files · ${total} comments (${accepted} accepted)`;
		}
		case "vetting": {
			const total = state.comments.length;
			return `${prRef} · Final vetting · ${total} comments`;
		}
		case "posting":
			return `${prRef} · Posting review…`;
	}
}

/** Update status line and detail widget to reflect current state. */
function updateUI(state: PRReviewState, ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setStatus(PERSIST_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const prRef = state.prNumber ? `#${state.prNumber}` : "?";
	ctx.ui.setStatus(
		PERSIST_KEY,
		`${theme.fg("accent", STATUS_GLYPH)} ${theme.fg("muted", `PR ${prRef} review`)}`,
	);

	const detail = buildDetailText(state);
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render(width: number): string[] {
			const truncated = truncateToWidth(detail, width);
			const text = theme.fg("dim", truncated);
			const pad = Math.max(0, width - visibleWidth(truncated));
			return [`${" ".repeat(pad)}${text}`];
		},
	}));
}

/** Enter PR review mode. */
export function activate(
	state: PRReviewState,
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.enabled = true;
	updateUI(state, ctx);
}

/** Exit PR review mode and clean up state. */
export function deactivate(
	state: PRReviewState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	resetState(state);
	updateUI(state, ctx);
	persist(state, pi);
}

/** Refresh the UI to reflect state changes. */
export function refreshUI(state: PRReviewState, ctx: ExtensionContext): void {
	updateUI(state, ctx);
}

/** Save state to session history. */
export function persist(state: PRReviewState, pi: ExtensionAPI): void {
	pi.appendEntry(PERSIST_KEY, {
		enabled: state.enabled,
		prNumber: state.prNumber,
		owner: state.owner,
		repo: state.repo,
		prBranch: state.prBranch,
		baseBranch: state.baseBranch,
		prAuthor: state.prAuthor,
		worktreePath: state.worktreePath,
		usingWorktree: state.usingWorktree,
		isReReview: state.isReReview,
		previousReviews: state.previousReviews,
		previousThreads: state.previousThreads,
		phase: state.phase,
		fileIndex: state.fileIndex,
		commentIndex: state.commentIndex,
		comments: state.comments,
		commentStates: Array.from(state.commentStates.entries()),
		descriptionComments: state.descriptionComments,
		reviewBody: state.reviewBody,
		verdict: state.verdict,
		researchNotes: state.researchNotes,
	});
}

/** Restore state from session history on startup. */
export function restore(state: PRReviewState, ctx: ExtensionContext): void {
	const saved = getLastEntry<{
		enabled?: boolean;
		prNumber?: number;
		owner?: string;
		repo?: string;
		prBranch?: string;
		baseBranch?: string;
		prAuthor?: string;
		worktreePath?: string;
		usingWorktree?: boolean;
		isReReview?: boolean;
		previousReviews?: PreviousReview[];
		previousThreads?: PreviousThread[];
		phase?: ReviewPhase;
		fileIndex?: number;
		commentIndex?: number;
		comments?: ReviewComment[];
		commentStates?: Array<[string, CommentState]>;
		descriptionComments?: ReviewComment[];
		reviewBody?: string;
		verdict?: ReviewVerdict;
		researchNotes?: string[];
	}>(ctx, PERSIST_KEY);

	if (!saved) return;

	state.enabled = saved.enabled ?? false;
	state.prNumber = saved.prNumber ?? null;
	state.owner = saved.owner ?? null;
	state.repo = saved.repo ?? null;
	state.prBranch = saved.prBranch ?? null;
	state.baseBranch = saved.baseBranch ?? null;
	state.prAuthor = saved.prAuthor ?? null;
	state.worktreePath = saved.worktreePath ?? null;
	state.usingWorktree = saved.usingWorktree ?? false;
	state.isReReview = saved.isReReview ?? false;
	state.previousReviews = saved.previousReviews ?? [];
	state.previousThreads = saved.previousThreads ?? [];
	state.phase = saved.phase ?? "gathering";
	state.fileIndex = saved.fileIndex ?? 0;
	state.commentIndex = saved.commentIndex ?? 0;
	state.comments = saved.comments ?? [];
	state.descriptionComments = saved.descriptionComments ?? [];
	state.reviewBody = saved.reviewBody ?? null;
	state.verdict = saved.verdict ?? "COMMENT";
	state.researchNotes = saved.researchNotes ?? [];

	if (saved.commentStates) {
		state.commentStates = new Map(saved.commentStates);
	}

	updateUI(state, ctx);
}
