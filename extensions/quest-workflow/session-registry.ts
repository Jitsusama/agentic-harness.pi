/**
 * Real-dependency wiring for the session registry.
 *
 * The pure store in `lib/internal/quest/session-registry` shapes
 * records and answers questions about them. This module supplies the
 * live pieces: where the records live, reading and writing them, the
 * heartbeat that dates a death nothing else can date, and the repair
 * a reader performs when it finds a session's process gone.
 *
 * Every record is written by exactly one live process, its own, so
 * there is no lock here and no read-modify-write race to protect
 * against. The one exception is the repair below, which writes to a
 * record whose owner is by definition no longer running.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../lib/internal/paths.js";
import { atomicWriteFile } from "../../lib/internal/quest/io.js";
import {
	localProcessDeps,
	probeProcess,
} from "../../lib/internal/quest/process-liveness.js";
import {
	closeRecord,
	openRecord,
	parseSessionRecord,
	pruneRecords,
	reopenRecord,
	restorable,
	type SessionEndReason,
	type SessionRecord,
	switchQuest,
} from "../../lib/internal/quest/session-registry.js";
import type { QuestSession } from "../../lib/quest/index.js";
import {
	getTypeProvider,
	spawnTerminalSurface,
} from "../../lib/terminal/index.js";

/** Where the per-session records live. */
export function sessionRegistryDir(): string {
	return join(stateDir("quest-workflow"), "sessions");
}

/**
 * Session ids are uuids, so anything else is either corruption or an
 * attempt to escape the directory. Reject rather than sanitize: a
 * silently rewritten id would address the wrong record.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** The file one session's record lives in, or undefined for a bad id. */
function recordPath(sessionId: string): string | undefined {
	if (!SAFE_SESSION_ID.test(sessionId)) return undefined;
	return join(sessionRegistryDir(), `${sessionId}.json`);
}

/** A record as read from disk, with the heartbeat its mtime carries. */
export interface StoredRecord {
	record: SessionRecord;
	/** When the file was last touched, which is the heartbeat. */
	heartbeatAt: string;
}

/**
 * Every record on disk. A file that cannot be read or cannot be
 * trusted is skipped, so one corrupt record never blinds the reader
 * to the rest.
 */
export function loadRecords(): StoredRecord[] {
	let names: string[];
	try {
		names = readdirSync(sessionRegistryDir());
	} catch {
		// No registry yet: nothing has ever been recorded.
		return [];
	}
	const stored: StoredRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(sessionRegistryDir(), name);
		try {
			const record = parseSessionRecord(JSON.parse(readFileSync(path, "utf8")));
			if (!record) continue;
			stored.push({
				record,
				heartbeatAt: statSync(path).mtime.toISOString(),
			});
		} catch {
			// Unreadable, half-written or not JSON. Skipping one record is
			// always better than failing the whole read.
		}
	}
	return stored;
}

/** Write a record, creating the registry directory on demand. */
export function saveRecord(record: SessionRecord): void {
	const path = recordPath(record.sessionId);
	if (!path) return;
	mkdirSync(sessionRegistryDir(), { recursive: true });
	atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** Read one session's record, or undefined when there is none. */
export function readRecord(sessionId: string): SessionRecord | undefined {
	const path = recordPath(sessionId);
	if (!path) return undefined;
	try {
		return parseSessionRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// Missing or unreadable reads the same as never recorded.
		return undefined;
	}
}

/** Drop a record entirely, for pruning. */
export function forgetRecord(sessionId: string): void {
	const path = recordPath(sessionId);
	if (!path) return;
	try {
		unlinkSync(path);
	} catch {
		// Already gone, or never written; either way there is nothing
		// left to forget.
	}
}

/**
 * Touch a record's mtime, which is the heartbeat.
 *
 * Metadata only, because this runs on a timer for the life of every
 * tab: a touch costs microseconds where rewriting the file costs an
 * order of magnitude more. The heartbeat is never consulted to decide
 * whether a session is alive, only to date a death that nothing else
 * can date, so a missed touch can stale one ordering timestamp and
 * can never manufacture a false death.
 */
export function touchHeartbeat(sessionId: string): void {
	const path = recordPath(sessionId);
	if (!path) return;
	try {
		const now = new Date();
		utimesSync(path, now, now);
	} catch {
		// No record to touch yet, or the state directory has gone. The
		// heartbeat is an optimization on dating, never a correctness
		// requirement, so failing it silently is the right cost.
	}
}

/**
 * How often a running session re-dates its own record.
 *
 * This only bounds how far out a crash death can be dated, since
 * nothing consults the heartbeat to decide whether a session is
 * alive. A minute is far finer than any ordering needs and cheap
 * enough to disappear: the touch is metadata only.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** The running heartbeat, at most one per process. */
let heartbeat: ReturnType<typeof setInterval> | undefined;

/**
 * Start re-dating this session's record on a timer.
 *
 * The timer is unref'd, so it never holds the process open on its
 * own: a pi that is otherwise finished must still be allowed to
 * exit. Starting twice replaces the first timer rather than running
 * two.
 */
export function startHeartbeat(
	sessionId: string,
	intervalMs: number = HEARTBEAT_INTERVAL_MS,
): void {
	stopHeartbeat();
	heartbeat = setInterval(() => touchHeartbeat(sessionId), intervalMs);
	heartbeat.unref?.();
}

/**
 * Stop re-dating. Call this before stamping a record closed: a tick
 * that lands afterwards would touch the file again and re-date a
 * session that has already ended.
 */
export function stopHeartbeat(): void {
	if (!heartbeat) return;
	clearInterval(heartbeat);
	heartbeat = undefined;
}

/**
 * Forget the records of sessions that ended longer ago than the
 * retention window, and report how many went.
 *
 * Only a record that can be proved to have ended is eligible.
 * Pruning refuses to forget a session it cannot prove is over,
 * because a tab that outlives the window is still a tab, and
 * dropping its record would make an open session disappear from
 * every view that asks.
 */
export function pruneClosedRecords(retentionDays: number): number {
	const { dropped } = pruneRecords(
		loadRecords().map((entry) => entry.record),
		{ now: new Date(), retentionDays },
	);
	for (const record of dropped) forgetRecord(record.sessionId);
	return dropped.length;
}

/**
 * Give records to tabs that were already open when the registry
 * arrived, so the first read is not blind to everything on screen.
 *
 * Only a session that probes alive is seeded. History is not evidence
 * a tab exists, and a record invented for one that ended long ago
 * would be offered back as lost, which is the failure this whole
 * record set replaces. Unprobeable is not alive either: an inability
 * to observe must never become a claim in either direction.
 *
 * A session the registry already knows is left alone. The record its
 * owning process wrote is the better one, and overwriting it with a
 * reconstruction would trade a real history for a guess.
 */
export function seedLiveSessions(
	claims: readonly { questId: string; session: QuestSession }[],
): SessionRecord[] {
	const deps = localProcessDeps();
	const seeded: SessionRecord[] = [];
	const now = new Date();
	for (const { questId, session } of claims) {
		if (!session.process || readRecord(session.id)) continue;
		if (probeProcess(session.process, deps) !== "matching") continue;
		const record = openRecord({
			sessionId: session.id,
			// A pre-registry session may predate instance ids too. Its own
			// id stands in: it identifies the tab uniquely, which is all
			// the field is for, and cannot collide with a real one.
			instanceId: session.instanceId ?? session.id,
			cwd: session.cwd ?? "",
			questId,
			process: session.process,
			...(session.terminal ? { terminal: session.terminal } : {}),
			// Dated from when the session started rather than now, so a
			// long-running tab is not made to look freshly opened.
			now: session.started ? new Date(session.started) : now,
		});
		saveRecord(record);
		seeded.push(record);
	}
	return seeded;
}

/** What one pass of {@link observeRecords} changed on disk. */
export interface ObservedRecords {
	/** Records closed because their process was found gone. */
	repaired: SessionRecord[];
	/** Session ids found alive, and re-dated on the strength of it. */
	refreshed: string[];
}

/**
 * Probe every open record once and write back what was learned.
 *
 * Two things come out of the same probe. A record whose process is
 * gone gets closed, which is the repair a crash makes necessary: a
 * process killed with its terminal never runs its own shutdown, so
 * its record would claim to be open forever, and pruning refuses to
 * forget a session it cannot prove has ended. The stamp is the
 * record's own heartbeat, the last moment anything saw it alive, and
 * the reason marks it approximate.
 *
 * A record whose process is alive gets re-dated, so an idle tab is
 * kept current by whoever asks rather than only by its own timer.
 * That is what stops a long-lived tab looking staler than a busy one.
 *
 * Only a record carrying a process identity is judged either way:
 * without one there is nothing to probe, and an inability to observe
 * must never read as death. Writing to another session's record is
 * safe when it is gone, and re-dating a live one races only with its
 * own heartbeat, which writes the same kind of answer.
 */
export function observeRecords(
	stored: readonly StoredRecord[],
): ObservedRecords {
	const deps = localProcessDeps();
	const repaired: SessionRecord[] = [];
	const refreshed: string[] = [];
	for (const { record, heartbeatAt } of stored) {
		if (record.closedAt || !record.process) continue;
		const probe = probeProcess(record.process, deps);
		if (probe === "gone") {
			const closed = closeRecord(record, "died", new Date(heartbeatAt));
			saveRecord(closed);
			repaired.push(closed);
			continue;
		}
		if (probe === "matching") {
			touchHeartbeat(record.sessionId);
			refreshed.push(record.sessionId);
		}
	}
	return { repaired, refreshed };
}

/** Apply an end reason to a session's record, if it has one. */
export function recordSessionEnd(
	sessionId: string,
	reason: SessionEndReason,
	now = new Date(),
): void {
	const record = readRecord(sessionId);
	if (!record) return;
	saveRecord(closeRecord(record, reason, now));
}

/**
 * The sessions worth offering back, newest loss first.
 *
 * Probes first, so a session lost to a crash is recognised as lost
 * before the question is asked: the record it left behind still
 * claims to be open, and only a probe can settle that.
 */
export function restorableSessions(): SessionRecord[] {
	const stored = loadRecords();
	observeRecords(stored);
	// Re-read rather than patching the list in place: observing writes
	// the repairs to disk, and the reload is what makes the answer the
	// same one a second reader would get.
	return restorable(loadRecords().map((entry) => entry.record));
}

/** What happened when restore tried to reopen the lost sessions. */
export interface ReopenOutcome {
	reopened: string[];
	failed: { sessionId: string; reason: string }[];
}

/**
 * Reopen lost sessions by spawning a shell for each and typing the
 * resume line into it.
 *
 * The two steps are the point. Handing the resume line to the spawn
 * primitive runs it under a non-interactive shell, which skips the
 * startup files that put the right pi on PATH, so the command that
 * works when typed fails when spawned. That is exactly what made the
 * manual recovery take an hour. Spawning a bare login shell and
 * typing into it is what a person does, and it works for the same
 * reason.
 *
 * A driver that cannot type is refused rather than worked around.
 * The only fallback available is the broken one.
 */
export async function reopenLostSessions(
	records: readonly SessionRecord[],
): Promise<ReopenOutcome> {
	const outcome: ReopenOutcome = { reopened: [], failed: [] };
	for (const record of records) {
		try {
			const { driver, handle } = await spawnTerminalSurface({
				layout: "tab",
				cwd: record.cwd,
			});
			if (!handle) {
				outcome.failed.push({
					sessionId: record.sessionId,
					reason: `the ${driver.id} driver cannot say which surface it opened`,
				});
				continue;
			}
			const typist = getTypeProvider(driver.id);
			if (!typist) {
				outcome.failed.push({
					sessionId: record.sessionId,
					reason: `the ${driver.id} driver cannot type into a surface`,
				});
				continue;
			}
			await typist.typeInto(handle, `pi --session ${record.sessionId}\n`);
			outcome.reopened.push(record.sessionId);
		} catch (error) {
			outcome.failed.push({
				sessionId: record.sessionId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return outcome;
}

/** What the caller knows about the session loading a quest. */
export interface OnQuestInput {
	sessionId: string;
	cwd: string;
	questId: string;
	instanceId: string;
	process?: SessionRecord["process"];
	terminal?: SessionRecord["terminal"];
}

/**
 * Note that a session is now on a quest, opening its record the first
 * time and moving it thereafter.
 *
 * Registration is triggered by loading a quest rather than by
 * starting a session, so a tab that never loads one is never
 * recorded. A session that later unloads keeps its record: once a tab
 * is known it stays tracked until it ends, since dropping it would
 * make an open tab disappear from the open set.
 */
export function recordSessionOnQuest(
	input: OnQuestInput,
	now = new Date(),
): void {
	const existing = readRecord(input.sessionId);
	if (existing) {
		// A closed record here means the session was resumed: this
		// process is running a conversation something else ended. Put it
		// back in the open set under our identity, or restore would go on
		// offering a tab the user has already brought back.
		const live = existing.closedAt
			? reopenRecord(existing, {
					instanceId: input.instanceId,
					...(input.process ? { process: input.process } : {}),
					...(input.terminal ? { terminal: input.terminal } : {}),
				})
			: existing;
		saveRecord(switchQuest(live, input.questId, now));
		return;
	}
	saveRecord(
		openRecord({
			sessionId: input.sessionId,
			instanceId: input.instanceId,
			cwd: input.cwd,
			questId: input.questId,
			...(input.process ? { process: input.process } : {}),
			...(input.terminal ? { terminal: input.terminal } : {}),
			now,
		}),
	);
}

/**
 * How a pi shutdown reason translates to the end of a session record,
 * or undefined when the record should be left alone.
 *
 * Only `quit` takes the tab with it. A `reload` keeps the same
 * session running in the same process, so nothing has ended at all.
 * The rest replace the conversation inside a tab that is still on
 * screen, which ends the session but not the tab, and the successor
 * opens its own record carrying the same instance id.
 */
export function endReasonForShutdown(
	reason: string | undefined,
): SessionEndReason | undefined {
	if (reason === "reload") return undefined;
	if (reason === "quit") return "quit";
	return "swapped";
}
