/**
 * Manages the PR review lifecycle: activation, deactivation,
 * persisting state, restoring it on return, and keeping the
 * status line up to date.
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
	commentStats,
	type PRReviewState,
	type PRTarget,
	type ReviewObservation,
	type ReviewPhase,
	type ReviewVerdict,
	resetState,
} from "./state.js";

/** Persist key for session history entries. */
const PERSIST_KEY = "pr-review";

/** Widget key for the detail line above the editor. */
const WIDGET_KEY = "pr-review-detail";

/** Shared config for status line and detail widget. */
const STATUS_CONFIG: WorkflowStatusConfig = {
	statusKey: PERSIST_KEY,
	widgetKey: WIDGET_KEY,
	label: "PR Review",
};

/** Build the detail widget text for the current phase. */
function buildDetailText(state: PRReviewState): string | null {
	const session = state.session;
	if (!session) return null;

	const prRef = `PR #${session.pr.number}`;
	const stats = commentStats(session);
	const total =
		stats.proposed + stats.pending + stats.approved + stats.rejected;

	switch (session.phase) {
		case "gathering":
			return `${prRef} · Gathering…`;
		case "overview":
			return `${prRef} · Overview`;
		case "reviewing": {
			if (total === 0) return `${prRef} · Review`;
			const resolved = stats.approved + stats.rejected;
			const proposedPart = stats.proposed > 0 ? ` ${stats.proposed}◇` : "";
			return `${prRef} · Review · ${resolved}/${total} (${stats.approved}✓ ${stats.rejected}✕ ${stats.pending}○${proposedPart})`;
		}
		case "submitting":
			return `${prRef} · Submit`;
	}
}

/** Update status line and detail widget to reflect current state. */
function updateUI(state: PRReviewState, ctx: ExtensionContext): void {
	updateWorkflowStatus(STATUS_CONFIG, state, ctx, () => buildDetailText(state));
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

/** Shape of the persisted session data. */
interface PersistedSession {
	pr: PRTarget;
	repoPath: string;
	worktreePath: string | null;
	synopsis: string;
	scopeAnalysis: string;
	comments: ReviewObservation[];
	tabStates: [
		string,
		{
			passed?: boolean;
			/** @deprecated Old name for passed. Kept for backward compat on restore. */
			handled?: boolean;
			activeView: string;
			commentIndex: number;
		},
	][];
	reviewBody: string;
	verdict: ReviewVerdict;
	phase: ReviewPhase;
}

/** Shape of the full persisted state. */
interface PersistedState {
	enabled: boolean;
	session: PersistedSession | null;
}

/** Save state to session history. */
export function persist(state: PRReviewState, pi: ExtensionAPI): void {
	const persisted: PersistedState = {
		enabled: state.enabled,
		session: state.session
			? {
					pr: state.session.pr,
					repoPath: state.session.repoPath,
					worktreePath: state.session.worktreePath,
					synopsis: state.session.synopsis,
					scopeAnalysis: state.session.scopeAnalysis,
					comments: state.session.comments,
					tabStates: [...state.session.tabStates.entries()].map(
						([key, val]) => [
							key,
							{
								passed: val.passed,
								activeView: val.activeView,
								commentIndex: val.commentIndex,
							},
						],
					),
					reviewBody: state.session.reviewBody,
					verdict: state.session.verdict,
					phase: state.session.phase,
				}
			: null,
	};
	pi.appendEntry(PERSIST_KEY, persisted);
}

/** Restore state from session history on startup. */
export function restore(state: PRReviewState, ctx: ExtensionContext): void {
	const saved = getLastEntry<PersistedState>(ctx, PERSIST_KEY);
	if (!saved) return;

	state.enabled = saved.enabled ?? false;

	if (saved.session) {
		const tabStates = new Map<
			string,
			{
				passed: boolean;
				activeView: "overview" | "comments" | "raw";
				commentIndex: number;
			}
		>();
		if (saved.session.tabStates) {
			for (const [key, val] of saved.session.tabStates) {
				tabStates.set(key, {
					// The `handled` fallback covers sessions persisted before the rename.
					passed: val.passed ?? val.handled ?? false,
					activeView: val.activeView as "overview" | "comments" | "raw",
					commentIndex: val.commentIndex,
				});
			}
		}

		state.session = {
			pr: saved.session.pr,
			context: null, // Re-crawled on demand
			repoPath: saved.session.repoPath,
			worktreePath: saved.session.worktreePath ?? null,
			synopsis: saved.session.synopsis ?? "",
			scopeAnalysis: saved.session.scopeAnalysis ?? "",
			comments: saved.session.comments ?? [],
			tabStates,
			reviewBody: saved.session.reviewBody ?? "",
			verdict: saved.session.verdict ?? "COMMENT",
			phase: saved.session.phase ?? "gathering",
		};
	}

	updateUI(state, ctx);
}
