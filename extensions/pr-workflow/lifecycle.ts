/**
 * Session persistence for pr-workflow.
 *
 * Pi reloads extensions on `/reload`, which re-invokes
 * each extension's default export and rebuilds module
 * state from scratch. Without persistence, the user
 * loses everything they configured and every decision
 * they recorded the moment they reload to pick up an
 * extension code change.
 *
 * Phase 1 persisted config only (roster, judge,
 * loaded PR reference). Phase 2 expands
 * the snapshot to cover run history and Round-4
 * decisions so the fix loop survives `/reload`.
 *
 * Versioning: the wire format carries a `version` field.
 * Phase 1 entries lack one and are treated as `v0`. The
 * restore path hydrates only the fields the recorded
 * version is known to carry. Future bumps can either
 * read-and-upgrade or skip.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import { getLastEntry } from "../../lib/internal/state.js";
import type { CritiqueRun } from "./critique.js";
import type { CouncilRun } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import type { CouncilReviewer } from "./reviewer.js";
import type { StackFindingRun } from "./stack-findings.js";
import type {
	PrRunSnapshot,
	PrWorkflowState,
	ThreadsSnapshot,
} from "./state.js";
import type { FindingDecision } from "./synthesis.js";

/** Session-history namespace for this extension. */
const SESSION_KEY = "pr-workflow";

/** Current wire-format version. Bump when adding/changing fields. */
const SCHEMA_VERSION = 2;

/**
 * Map serialisation form. JSON.stringify on a Map
 * silently drops every entry, so we explicitly convert
 * to an array of pairs at the persist boundary.
 */
interface PersistedDecisionEntry {
	readonly findingId: number;
	readonly decision: FindingDecision;
}

/**
 * Per-PR run snapshot in serialised form. Used inside
 * `stackRuns` so the user's prior decisions on
 * stack-mate PRs survive a reload mid-sweep.
 */
interface PersistedPrRunSnapshot {
	readonly prNumber: number;
	readonly lastRun: CouncilRun | null;
	readonly lastJudge: JudgeRun | null;
	readonly lastCritique: CritiqueRun | null;
	readonly decisions: readonly PersistedDecisionEntry[];
}

/**
 * What we write to session history.
 *
 * Versioned so future restores can read older entries
 * without crashing. v2 carries every field; v0 (Phase 1
 * entries that lack a `version`) only carries the
 * config + PR reference slice.
 */
interface PersistedState {
	readonly version: typeof SCHEMA_VERSION;
	// Phase 1 fields (also present on v0 entries):
	readonly roster: readonly CouncilReviewer[];
	readonly judge: CouncilReviewer | null;
	readonly prReference: PRReference | null;
	readonly prLoadedAt: string | null;
	// Phase 2 fields:
	readonly lastRun: CouncilRun | null;
	readonly lastJudge: JudgeRun | null;
	readonly lastCritique: CritiqueRun | null;
	readonly decisions: readonly PersistedDecisionEntry[];
	readonly stackFindingRun: StackFindingRun | null;
	readonly stackDecisions: readonly PersistedDecisionEntry[];
	readonly stackRuns: readonly PersistedPrRunSnapshot[];
	readonly threads: ThreadsSnapshot | null;
}

function serialiseDecisions(
	map: ReadonlyMap<number, FindingDecision>,
): PersistedDecisionEntry[] {
	return Array.from(map.entries()).map(([findingId, decision]) => ({
		findingId,
		decision,
	}));
}

function deserialiseDecisions(
	entries: readonly PersistedDecisionEntry[] | undefined,
): Map<number, FindingDecision> {
	const map = new Map<number, FindingDecision>();
	if (!entries) return map;
	for (const entry of entries) {
		map.set(entry.findingId, entry.decision);
	}
	return map;
}

function serialiseStackRuns(
	map: ReadonlyMap<number, PrRunSnapshot>,
): PersistedPrRunSnapshot[] {
	return Array.from(map.entries()).map(([prNumber, snapshot]) => ({
		prNumber,
		lastRun: snapshot.lastRun,
		lastJudge: snapshot.lastJudge,
		lastCritique: snapshot.lastCritique,
		decisions: serialiseDecisions(snapshot.decisions),
	}));
}

function deserialiseStackRuns(
	entries: readonly PersistedPrRunSnapshot[] | undefined,
): Map<number, PrRunSnapshot> {
	const map = new Map<number, PrRunSnapshot>();
	if (!entries) return map;
	for (const entry of entries) {
		map.set(entry.prNumber, {
			lastRun: entry.lastRun,
			lastJudge: entry.lastJudge,
			lastCritique: entry.lastCritique,
			decisions: deserialiseDecisions(entry.decisions),
		});
	}
	return map;
}

/**
 * Snapshot the persisted slice of state. Pure: callers
 * own the side effect of writing it.
 */
function snapshot(state: PrWorkflowState): PersistedState {
	return {
		version: SCHEMA_VERSION,
		roster: state.council.roster,
		judge: state.council.judge,
		prReference: state.pr?.reference ?? null,
		prLoadedAt: state.pr?.loadedAt ?? null,
		lastRun: state.council.lastRun,
		lastJudge: state.council.lastJudge,
		lastCritique: state.council.lastCritique,
		decisions: serialiseDecisions(state.council.decisions),
		stackFindingRun: state.stackFindingRun,
		stackDecisions: serialiseDecisions(state.stackDecisions),
		stackRuns: serialiseStackRuns(state.stackRuns),
		threads: state.threads,
	};
}

/**
 * Persist the current state to session history.
 *
 * Idempotent in effect: each call appends a new entry,
 * and `restore` reads only the most recent one. Older
 * entries become dead weight in the log but don't
 * cause incorrect behaviour. Session-history append is
 * how pi expects extensions to record durable state.
 */
export function persist(state: PrWorkflowState, pi: ExtensionAPI): void {
	pi.appendEntry(SESSION_KEY, snapshot(state));
}

/**
 * Restore the persisted slice into a fresh state.
 * No-op when nothing has been persisted yet. Older v0
 * entries only hydrate the fields they carried; the rest
 * stay at their initial-state defaults.
 */
export function restore(
	state: PrWorkflowState,
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const saved = getLastEntry<Partial<PersistedState>>(ctx, SESSION_KEY);
	if (!saved) return;

	// Baseline fields: present on every recorded version.
	if (saved.roster) state.council.roster = [...saved.roster];
	if (saved.judge !== undefined) state.council.judge = saved.judge;
	if (saved.prReference && saved.prLoadedAt) {
		state.pr = {
			reference: saved.prReference,
			loadedAt: saved.prLoadedAt,
			metadata: null,
			files: null,
			stack: null,
		};
	}

	// Run-history fields: only present on v2+ entries.
	if (saved.version === undefined) return;

	if (saved.lastRun !== undefined) state.council.lastRun = saved.lastRun;
	if (saved.lastJudge !== undefined) state.council.lastJudge = saved.lastJudge;
	if (saved.lastCritique !== undefined) {
		state.council.lastCritique = saved.lastCritique;
	}
	state.council.decisions = deserialiseDecisions(saved.decisions);

	if (saved.stackFindingRun !== undefined) {
		state.stackFindingRun = saved.stackFindingRun;
	}
	state.stackDecisions = deserialiseDecisions(saved.stackDecisions);
	state.stackRuns = deserialiseStackRuns(saved.stackRuns);

	if (saved.threads !== undefined) state.threads = saved.threads;
}
