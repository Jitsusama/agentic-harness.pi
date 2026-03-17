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
	commentsByStatus,
	type PRReviewState,
	type PRTarget,
	type PreviousReviewData,
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
	const prNum = state.session?.pr.number ?? "?";
	const prRef = `PR #${prNum}`;

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
			const fileCount = state.session?.context?.diffFiles.length ?? 0;
			const accepted = state.session
				? commentsByStatus(state.session, "accepted").length
				: 0;
			const total = state.session?.comments.length ?? 0;
			return `${prRef} · file-review · ${state.fileIndex + 1}/${fileCount} files · ${total} comments (${accepted} accepted)`;
		}
		case "vetting": {
			const total = state.session?.comments.length ?? 0;
			return `${prRef} · Final vetting · ${total} comments`;
		}
		case "posting":
			return `${prRef} · Posting review…`;
	}
}

/** Update status line and detail widget to reflect current state. */
function updateUI(state: PRReviewState, ctx: ExtensionContext): void {
	if (!state.enabled || !state.session) {
		ctx.ui.setStatus(PERSIST_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const prRef = `#${state.session.pr.number}`;
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

// ---- Persistence ----

/** Shape of the persisted session data. */
interface PersistedSession {
	pr: PRTarget;
	worktreePath: string | null;
	usingWorktree: boolean;
	previousReview: PreviousReviewData | null;
	comments: ReviewComment[];
	body: string;
	verdict: ReviewVerdict;
}

/** Shape of the full persisted state. */
interface PersistedState {
	enabled: boolean;
	session: PersistedSession | null;
	phase: ReviewPhase;
	fileIndex: number;
}

/** Save state to session history. */
export function persist(state: PRReviewState, pi: ExtensionAPI): void {
	const persisted: PersistedState = {
		enabled: state.enabled,
		session: state.session
			? {
					pr: state.session.pr,
					worktreePath: state.session.worktreePath,
					usingWorktree: state.session.usingWorktree,
					previousReview: state.session.previousReview,
					comments: state.session.comments,
					body: state.session.body,
					verdict: state.session.verdict,
				}
			: null,
		phase: state.phase,
		fileIndex: state.fileIndex,
	};
	pi.appendEntry(PERSIST_KEY, persisted);
}

/** Restore state from session history on startup. */
export function restore(state: PRReviewState, ctx: ExtensionContext): void {
	const saved = getLastEntry<PersistedState>(ctx, PERSIST_KEY);
	if (!saved) return;

	state.enabled = saved.enabled ?? false;
	state.phase = saved.phase ?? "gathering";
	state.fileIndex = saved.fileIndex ?? 0;

	if (saved.session) {
		state.session = {
			pr: saved.session.pr,
			context: null, // Re-fetched on demand via ensureContext
			worktreePath: saved.session.worktreePath,
			usingWorktree: saved.session.usingWorktree,
			previousReview: saved.session.previousReview,
			comments: saved.session.comments ?? [],
			body: saved.session.body ?? "",
			verdict: saved.session.verdict ?? "COMMENT",
		};
	}

	updateUI(state, ctx);
}
