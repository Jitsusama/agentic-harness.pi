/**
 * Session persistence for pr-workflow.
 *
 * Pi reloads extensions on `/reload`, which re-invokes
 * each extension's default export and rebuilds module
 * state from scratch. Without persistence, the user's
 * council roster, judge config, stack-critic config and
 * loaded PR vanish on every reload, forcing them to
 * reconfigure reviewers before resuming work.
 *
 * This module persists the cheap-to-replay config —
 * roster, judge, stack-critic, the loaded PR's
 * reference and load timestamp — to session history.
 * Run output (council findings, judge consolidations,
 * decisions, thread snapshots) is intentionally NOT
 * persisted: those carry Map-keyed data with schema
 * drift risk, and a council can be re-run after a
 * reload without losing user intent.
 *
 * If a future PR adds run-history persistence, it
 * needs to handle Map serialization explicitly and
 * version the wire format. Don't bolt it onto the
 * shape here.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import { getLastEntry } from "../../lib/internal/state.js";
import type { CouncilReviewer } from "./reviewer.js";
import type { PrWorkflowState } from "./state.js";

/** Session-history namespace for this extension. */
const SESSION_KEY = "pr-workflow";

/**
 * What we write to session history. Kept narrow so the
 * wire format doesn't tangle with the in-memory shape.
 */
interface PersistedState {
	readonly roster: readonly CouncilReviewer[];
	readonly judge: CouncilReviewer | null;
	readonly stackCritic: CouncilReviewer | null;
	readonly prReference: PRReference | null;
	readonly prLoadedAt: string | null;
}

/**
 * Snapshot the persisted slice of state. Pure: callers
 * own the side effect of writing it.
 */
function snapshot(state: PrWorkflowState): PersistedState {
	return {
		roster: state.council.roster,
		judge: state.council.judge,
		stackCritic: state.council.stackCritic,
		prReference: state.pr?.reference ?? null,
		prLoadedAt: state.pr?.loadedAt ?? null,
	};
}

/**
 * Persist the current config slice to session history.
 *
 * Idempotent in effect: each call appends a new entry,
 * and `restore` reads only the most recent one. Older
 * entries are dead weight but don't cause incorrect
 * behaviour.
 */
export function persist(state: PrWorkflowState, pi: ExtensionAPI): void {
	pi.appendEntry(SESSION_KEY, snapshot(state));
}

/**
 * Restore the persisted config slice into a fresh
 * state. No-op when nothing has been persisted yet.
 *
 * The PR's derived data (metadata, files, stack) is
 * not persisted; it re-fetches on the next interaction
 * that needs it. Reviewer runs are not persisted; the
 * user re-runs them if they want fresh findings after
 * a reload.
 */
export function restore(
	state: PrWorkflowState,
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const saved = getLastEntry<PersistedState>(ctx, SESSION_KEY);
	if (!saved) return;

	state.council.roster = [...saved.roster];
	state.council.judge = saved.judge;
	state.council.stackCritic = saved.stackCritic;

	if (saved.prReference && saved.prLoadedAt) {
		state.pr = {
			reference: saved.prReference,
			loadedAt: saved.prLoadedAt,
			metadata: null,
			files: null,
			stack: null,
		};
	}
}
