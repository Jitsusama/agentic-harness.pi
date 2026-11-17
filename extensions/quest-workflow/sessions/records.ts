/**
 * The session records on disk: where they live, reading and writing
 * them, and the repairs a reader makes when it finds them wrong.
 *
 * The pure store in `lib/internal/quest/sessions/session-registry` shapes
 * records and answers questions about them; this is the file side.
 * Every record is written by exactly one live process, its own, so
 * there is no lock here and no read-modify-write race to protect
 * against. The exception is the repair in `observeRecords`, which
 * writes to a record whose owner is by definition no longer running.
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
import { atomicWriteFile } from "../../../lib/internal/quest/io.ts";
import { sessionRegistryDir } from "../../../lib/internal/quest/sessions/loaded.ts";
import {
	localProcessDeps,
	probeProcess,
} from "../../../lib/internal/quest/sessions/process-liveness.ts";
import {
	closeRecord,
	openRecord,
	parseSessionRecord,
	pruneRecords,
	type SessionEndReason,
	type SessionRecord,
} from "../../../lib/internal/quest/sessions/session-registry.ts";
import { rosterHolds } from "../../../lib/internal/session/host-holds.ts";
import type { QuestSession } from "../../../lib/quest/index.ts";

/** Where the per-session records live. */
export { sessionRegistryDir };

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
			adopted: true,
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
 *
 * A session a host's roster keeps is never closed, whatever process
 * its record names: the old plain pi it moved from, or a host that
 * crashed and takes it up again as it starts. The host is its writer,
 * and its own heartbeat puts the record right.
 */
export function observeRecords(
	stored: readonly StoredRecord[],
	kept: () => ReadonlyMap<string, string> = rosterHolds,
): ObservedRecords {
	const deps = localProcessDeps();
	const repaired: SessionRecord[] = [];
	const refreshed: string[] = [];
	let holds: ReadonlyMap<string, string> | undefined;
	for (const { record, heartbeatAt } of stored) {
		if (record.closedAt || !record.process) continue;
		const probe = probeProcess(record.process, deps);
		if (probe === "gone") {
			// Read once a pass, and only when something reads gone.
			holds ??= kept();
			if (holds.has(record.sessionId)) continue;
			// Only a session that opened its own record had a shutdown hook
			// to skip, so only its silence means it was taken away. An
			// adopted one never had one, and reading its exit as a crash is
			// how a deliberately closed tab ends up offered back.
			const closed = closeRecord(
				record,
				record.adopted ? "vanished" : "died",
				new Date(heartbeatAt),
			);
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
