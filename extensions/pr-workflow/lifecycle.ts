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

import { createHash } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import { getLastEntry } from "../../lib/internal/state.js";
import type { CouncilReviewer } from "../../lib/subagent/subagent.js";
import type { CritiqueRun } from "./critique.js";
import type { CouncilRun } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import type { ParticipantIdentity } from "./participant-identities.js";
import type { RunBodyStore } from "./results-store.js";
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
const SCHEMA_VERSION = 5;

/** First version that stores run bodies by id instead of inline. */
const FIRST_POINTER_VERSION = 5;

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
 * Per-PR run snapshot in serialised form (v5). Carries run
 * id pointers instead of bodies; the bodies live in the
 * results store. Used inside `stackRuns` so the user's prior
 * decisions on stack-mate PRs survive a reload mid-sweep.
 */
interface PersistedPrRunSnapshot {
	readonly prNumber: number;
	readonly lastRunId: string | null;
	readonly lastJudgeId: string | null;
	readonly lastCritiqueId: string | null;
	readonly decisions: readonly PersistedDecisionEntry[];
}

/**
 * Per-PR run snapshot as written by v4 and earlier: the run
 * bodies were embedded inline. Kept so the restore path can
 * still read older entries.
 */
interface PersistedPrRunSnapshotV4 {
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
 * config + PR reference slice. v3 adds the session-global
 * finding id allocator. v4 adds stable participant identity
 * tracking for reviewer and judge ids that have produced output.
 */
interface PersistedState {
	readonly version: typeof SCHEMA_VERSION;
	// Phase 1 fields (also present on v0 entries):
	readonly roster: readonly CouncilReviewer[];
	readonly judge: CouncilReviewer | null;
	readonly prReference: PRReference | null;
	readonly prLoadedAt: string | null;
	// Phase 2 fields, v5 form: run id pointers, not bodies.
	readonly lastRunId: string | null;
	readonly lastJudgeId: string | null;
	readonly lastCritiqueId: string | null;
	readonly decisions: readonly PersistedDecisionEntry[];
	readonly stackFindingRun: StackFindingRun | null;
	readonly stackDecisions: readonly PersistedDecisionEntry[];
	readonly stackRuns: readonly PersistedPrRunSnapshot[];
	readonly threads: ThreadsSnapshot | null;
	// Phase 3 fields:
	readonly nextFindingId: number;
	// Phase 4 fields:
	readonly participantIdentities: readonly ParticipantIdentity[];
}

/**
 * Loose read shape spanning v0 through v5. Every field is
 * optional because the version that wrote the entry decides
 * which are present: v4 and earlier carry inline `lastRun`
 * bodies, v5 carries `lastRunId` pointers. The restore path
 * branches on `version` to read the right side.
 */
interface PersistedStateWire {
	readonly version?: number;
	readonly roster?: readonly CouncilReviewer[];
	readonly judge?: CouncilReviewer | null;
	readonly prReference?: PRReference | null;
	readonly prLoadedAt?: string | null;
	// v4 inline bodies:
	readonly lastRun?: CouncilRun | null;
	readonly lastJudge?: JudgeRun | null;
	readonly lastCritique?: CritiqueRun | null;
	// v5 pointers:
	readonly lastRunId?: string | null;
	readonly lastJudgeId?: string | null;
	readonly lastCritiqueId?: string | null;
	readonly decisions?: readonly PersistedDecisionEntry[];
	readonly stackFindingRun?: StackFindingRun | null;
	readonly stackDecisions?: readonly PersistedDecisionEntry[];
	readonly stackRuns?: readonly (
		| PersistedPrRunSnapshot
		| PersistedPrRunSnapshotV4
	)[];
	readonly threads?: ThreadsSnapshot | null;
	readonly nextFindingId?: number;
	readonly participantIdentities?: readonly ParticipantIdentity[];
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
		lastRunId: snapshot.lastRun?.id ?? null,
		lastJudgeId: snapshot.lastJudge?.id ?? null,
		lastCritiqueId: snapshot.lastCritique?.id ?? null,
		decisions: serialiseDecisions(snapshot.decisions),
	}));
}

/** True for a v4-and-earlier stack entry, which carries inline bodies. */
function isInlineStackEntry(
	entry: PersistedPrRunSnapshot | PersistedPrRunSnapshotV4,
): entry is PersistedPrRunSnapshotV4 {
	return "lastRun" in entry;
}

function deserialiseStackRuns(
	entries:
		| readonly (PersistedPrRunSnapshot | PersistedPrRunSnapshotV4)[]
		| undefined,
	store: RunBodyStore,
	missing: string[],
): Map<number, PrRunSnapshot> {
	const map = new Map<number, PrRunSnapshot>();
	if (!entries) return map;
	for (const entry of entries) {
		if (isInlineStackEntry(entry)) {
			map.set(entry.prNumber, {
				lastRun: entry.lastRun,
				lastJudge: entry.lastJudge,
				lastCritique: entry.lastCritique,
				decisions: deserialiseDecisions(entry.decisions),
			});
			continue;
		}
		map.set(entry.prNumber, {
			lastRun: readBody<CouncilRun>(
				entry.lastRunId,
				store,
				missing,
				`PR ${entry.prNumber} council`,
			),
			lastJudge: readBody<JudgeRun>(
				entry.lastJudgeId,
				store,
				missing,
				`PR ${entry.prNumber} judge`,
			),
			lastCritique: readBody<CritiqueRun>(
				entry.lastCritiqueId,
				store,
				missing,
				`PR ${entry.prNumber} critique`,
			),
			decisions: deserialiseDecisions(entry.decisions),
		});
	}
	return map;
}

/**
 * Read a run body from the store by id. A null or absent id
 * yields null with no fuss; a non-null id that the store can't
 * resolve records a human label in `missing` so restore can
 * surface the gap.
 */
function readBody<T>(
	id: string | null | undefined,
	store: RunBodyStore,
	missing: string[],
	label: string,
): T | null {
	if (!id) return null;
	const body = store.readRun<T>(id);
	if (!body) missing.push(`${label} run ${id}`);
	return body;
}

function serialiseParticipantIdentities(
	map: ReadonlyMap<string, ParticipantIdentity>,
): ParticipantIdentity[] {
	return Array.from(map.values());
}

function deserialiseParticipantIdentities(
	entries: readonly ParticipantIdentity[] | undefined,
): Map<string, ParticipantIdentity> {
	const map = new Map<string, ParticipantIdentity>();
	if (!entries) return map;
	for (const entry of entries) map.set(entry.id, entry);
	return map;
}

function inferNextFindingId(state: PrWorkflowState): number {
	let next = 1;
	for (const output of state.council.lastRun?.reviewerOutputs ?? []) {
		for (const finding of output.findings)
			next = Math.max(next, finding.id + 1);
	}
	for (const finding of state.council.lastJudge?.consolidatedFindings ?? []) {
		next = Math.max(next, finding.id + 1);
	}
	for (const finding of state.stackFindingRun?.findings ?? []) {
		next = Math.max(next, finding.id + 1);
	}
	for (const snapshot of state.stackRuns.values()) {
		for (const output of snapshot.lastRun?.reviewerOutputs ?? []) {
			for (const finding of output.findings) {
				next = Math.max(next, finding.id + 1);
			}
		}
		for (const finding of snapshot.lastJudge?.consolidatedFindings ?? []) {
			next = Math.max(next, finding.id + 1);
		}
	}
	return next;
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
		lastRunId: state.council.lastRun?.id ?? null,
		lastJudgeId: state.council.lastJudge?.id ?? null,
		lastCritiqueId: state.council.lastCritique?.id ?? null,
		decisions: serialiseDecisions(state.council.decisions),
		stackFindingRun: state.stackFindingRun,
		stackDecisions: serialiseDecisions(state.stackDecisions),
		stackRuns: serialiseStackRuns(state.stackRuns),
		threads: state.threads,
		nextFindingId: state.nextFindingId,
		participantIdentities: serialiseParticipantIdentities(
			state.participantIdentities,
		),
	};
}

/** Every run body currently held in memory, active PR and stack-mates. */
function* collectBodies(
	state: PrWorkflowState,
): Iterable<CouncilRun | JudgeRun | CritiqueRun> {
	if (state.council.lastRun) yield state.council.lastRun;
	if (state.council.lastJudge) yield state.council.lastJudge;
	if (state.council.lastCritique) yield state.council.lastCritique;
	for (const snap of state.stackRuns.values()) {
		if (snap.lastRun) yield snap.lastRun;
		if (snap.lastJudge) yield snap.lastJudge;
		if (snap.lastCritique) yield snap.lastCritique;
	}
}

/** Stable content hash of a run body, for change detection. */
function hashBody(body: CouncilRun | JudgeRun | CritiqueRun): string {
	return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Per-session record of the content hash last written for each
 * run id. Lets `writeChangedBodies` skip a body whose content is
 * unchanged (the common case, where only decisions or pointers
 * moved) while still catching an in-place edit that reuses a run
 * id, such as a zero-finding council-retry. Keyed by the
 * session's pi so it cannot leak across sessions.
 */
const writtenBodyHashes = new WeakMap<ExtensionAPI, Map<string, string>>();

function bodyHashesFor(pi: ExtensionAPI): Map<string, string> {
	let hashes = writtenBodyHashes.get(pi);
	if (!hashes) {
		hashes = new Map();
		writtenBodyHashes.set(pi, hashes);
	}
	return hashes;
}

/**
 * Write each in-memory run body whose content has changed since
 * it was last written for this session. A body is immutable for
 * a given run id in the common case, so most persists write
 * nothing; but an in-place edit that reuses an id changes the
 * hash and is written. The per-id hash advances only after a
 * successful write, so a throwing write is retried next time.
 */
function writeChangedBodies(
	state: PrWorkflowState,
	pi: ExtensionAPI,
	store: RunBodyStore,
): void {
	const hashes = bodyHashesFor(pi);
	for (const body of collectBodies(state)) {
		const hash = hashBody(body);
		if (hashes.get(body.id) === hash) continue;
		store.writeRun(body);
		hashes.set(body.id, hash);
	}
}

/**
 * Last snapshot we wrote, keyed by the pi API for the
 * session. The session log is append-only, so persisting
 * an unchanged snapshot is pure dead weight; the dirty
 * check below compares against this and skips the write
 * when nothing moved. A WeakMap keys the memory to the
 * session's pi instance without leaking across sessions.
 */
const lastSerialised = new WeakMap<ExtensionAPI, string>();

/**
 * Persist the current state to session history when it
 * has changed since the last write.
 *
 * `restore` reads only the most recent entry, so older
 * entries are dead weight; writing one on every tool call,
 * changed or not, is what bloated the log. The dirty check
 * serialises the candidate snapshot and skips the append
 * when it matches the last one written for this session.
 * Session-history append is how pi expects extensions to
 * record durable state.
 */
export function persist(
	state: PrWorkflowState,
	pi: ExtensionAPI,
	store: RunBodyStore,
): void {
	const snap = snapshot(state);
	const serialised = JSON.stringify(snap);
	const snapshotUnchanged = lastSerialised.get(pi) === serialised;
	try {
		// Bodies are checked on every persist, not gated by the
		// pointer dirty check: an in-place body edit (a zero-finding
		// council-retry reuses the run id) changes a transcript
		// without moving any pointer, and that edit must still reach
		// the store. writeChangedBodies skips bodies whose content is
		// unchanged, so this stays cheap.
		writeChangedBodies(state, pi, store);
		if (!snapshotUnchanged) {
			pi.appendEntry(SESSION_KEY, snap);
			lastSerialised.set(pi, serialised);
		}
	} catch {
		// Persistence is best-effort. It runs in the action finally,
		// so a disk error here must not mask the action that
		// triggered it. The dirty marker and per-id hashes advance
		// only on success, so a transient failure is retried on the
		// next persist rather than silently dropped.
	}
}

/**
 * Restore the persisted slice into a fresh state.
 * No-op when nothing has been persisted yet. Older v0
 * entries only hydrate the fields they carried; the rest
 * stay at their initial-state defaults.
 */
export function restore(
	state: PrWorkflowState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	store: RunBodyStore,
): void {
	const saved = getLastEntry<PersistedStateWire>(ctx, SESSION_KEY);
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

	// Run bodies. v5 carries id pointers and reads the bodies from
	// the store; v4 and earlier embedded the bodies inline. A
	// pointer that the store can't resolve (an expired transcript)
	// records a label in `missing` so we can explain the gap
	// instead of crashing.
	const missing: string[] = [];
	if (saved.version >= FIRST_POINTER_VERSION) {
		state.council.lastRun = readBody<CouncilRun>(
			saved.lastRunId,
			store,
			missing,
			"council",
		);
		state.council.lastJudge = readBody<JudgeRun>(
			saved.lastJudgeId,
			store,
			missing,
			"judge",
		);
		state.council.lastCritique = readBody<CritiqueRun>(
			saved.lastCritiqueId,
			store,
			missing,
			"critique",
		);
	} else {
		if (saved.lastRun !== undefined) state.council.lastRun = saved.lastRun;
		if (saved.lastJudge !== undefined) {
			state.council.lastJudge = saved.lastJudge;
		}
		if (saved.lastCritique !== undefined) {
			state.council.lastCritique = saved.lastCritique;
		}
	}
	state.council.decisions = deserialiseDecisions(saved.decisions);

	if (saved.stackFindingRun !== undefined) {
		state.stackFindingRun = saved.stackFindingRun;
	}
	state.stackDecisions = deserialiseDecisions(saved.stackDecisions);
	state.stackRuns = deserialiseStackRuns(saved.stackRuns, store, missing);

	if (saved.threads !== undefined) state.threads = saved.threads;

	state.nextFindingId = saved.nextFindingId ?? inferNextFindingId(state);
	state.participantIdentities = deserialiseParticipantIdentities(
		saved.participantIdentities,
	);

	state.degradedRunNotice =
		missing.length > 0
			? `Some run transcripts have expired and could not be restored ` +
				`(${missing.join(", ")}). Re-run to regenerate them.`
			: null;

	// Seed the dirty check and the per-id body hashes with the
	// restored state, so the first persist after a reload neither
	// re-appends the snapshot nor re-writes a body that already
	// round-tripped through the store.
	lastSerialised.set(pi, JSON.stringify(snapshot(state)));
	const hashes = bodyHashesFor(pi);
	for (const body of collectBodies(state)) hashes.set(body.id, hashBody(body));
}
