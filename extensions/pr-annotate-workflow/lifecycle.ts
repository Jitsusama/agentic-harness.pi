/**
 * Manages the annotation workflow lifecycle: activation,
 * deactivation, persisting state across sessions, and
 * keeping the status line up to date.
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
import { commentStats, resetState } from "./state.js";
import type {
	AnnotateComment,
	AnnotateSession,
	PRAnnotateState,
} from "./types.js";

/** Persist key for session history entries. */
const PERSIST_KEY = "pr-annotate";

/** Widget key for the detail line above the editor. */
const WIDGET_KEY = "pr-annotate-detail";

/** Shared config for status line and detail widget. */
const STATUS_CONFIG: WorkflowStatusConfig = {
	statusKey: PERSIST_KEY,
	widgetKey: WIDGET_KEY,
	label: "PR Annotate",
};

/** Build the detail widget text for the current session. */
function buildDetailText(state: PRAnnotateState): string | null {
	const session = state.session;
	if (!session) return null;

	const prRef = `PR #${session.pr}`;
	const stats = commentStats(session);
	const total = stats.pending + stats.approved + stats.rejected;

	if (total === 0) return `${prRef} · Annotate`;

	const resolved = stats.approved + stats.rejected;
	return `${prRef} · Annotate · ${resolved}/${total} (${stats.approved}✓ ${stats.rejected}✕ ${stats.pending}○)`;
}

/** Update status line and detail widget. */
function updateUI(state: PRAnnotateState, ctx: ExtensionContext): void {
	updateWorkflowStatus(STATUS_CONFIG, state, ctx, () => buildDetailText(state));
}

/** Enter annotation mode. */
export function activate(
	state: PRAnnotateState,
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.enabled = true;
	updateUI(state, ctx);
}

/** Exit annotation mode and clear state. */
export function deactivate(
	state: PRAnnotateState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	resetState(state);
	updateUI(state, ctx);
	persist(state, pi);
}

/** Refresh the UI to reflect state changes. */
export function refreshUI(state: PRAnnotateState, ctx: ExtensionContext): void {
	updateUI(state, ctx);
}

/** Shape of the persisted state. */
interface PersistedState {
	enabled: boolean;
	session: {
		pr: number;
		repo: string | null;
		reviewBody: string;
		comments: AnnotateComment[];
	} | null;
}

/** Save state to session history. */
export function persist(state: PRAnnotateState, pi: ExtensionAPI): void {
	const persisted: PersistedState = {
		enabled: state.enabled,
		session: state.session
			? {
					pr: state.session.pr,
					repo: state.session.repo,
					reviewBody: state.session.reviewBody,
					comments: state.session.comments,
				}
			: null,
	};
	pi.appendEntry(PERSIST_KEY, persisted);
}

/** Restore state from session history on startup. */
export function restore(state: PRAnnotateState, ctx: ExtensionContext): void {
	const saved = getLastEntry<PersistedState>(ctx, PERSIST_KEY);
	if (!saved) return;

	state.enabled = saved.enabled ?? false;

	if (saved.session) {
		state.session = {
			pr: saved.session.pr,
			repo: saved.session.repo,
			reviewBody: saved.session.reviewBody ?? "",
			comments: saved.session.comments ?? [],
			// Diff files aren't persisted; re-fetched on demand.
			diffFiles: [],
		};
	}

	updateUI(state, ctx);
}

/**
 * Ensure diff files are available on the session.
 * Fetches them if the session was restored without them.
 */
export async function ensureDiffFiles(
	state: PRAnnotateState,
	fetchDiff: () => Promise<AnnotateSession["diffFiles"]>,
): Promise<void> {
	if (!state.session) return;
	if (state.session.diffFiles.length > 0) return;
	state.session.diffFiles = await fetchDiff();
}
