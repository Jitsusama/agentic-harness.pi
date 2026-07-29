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
	parseSessionRecord,
	type SessionEndReason,
	type SessionRecord,
} from "../../lib/internal/quest/session-registry.js";

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
 * Close the records of sessions whose process a probe reads gone.
 *
 * This is the repair that a crash makes necessary: a process killed
 * with its terminal never runs its own shutdown, so its record would
 * otherwise claim to be open forever, and pruning deliberately never
 * forgets a session it cannot prove has ended.
 *
 * The stamp is the record's own heartbeat, the last moment anything
 * saw it alive, and the reason marks it approximate. Only a record
 * carrying a process identity is judged: without one there is nothing
 * to probe, and an inability to observe must never read as death.
 *
 * Writing to another session's record is safe precisely because the
 * owner is gone. Two readers repairing at once write the same answer.
 */
export function repairCrashedRecords(stored: readonly StoredRecord[]): {
	repaired: SessionRecord[];
} {
	const deps = localProcessDeps();
	const repaired: SessionRecord[] = [];
	for (const { record, heartbeatAt } of stored) {
		if (record.closedAt || !record.process) continue;
		if (probeProcess(record.process, deps) !== "gone") continue;
		const closed = closeRecord(record, "died", new Date(heartbeatAt));
		saveRecord(closed);
		repaired.push(closed);
	}
	return { repaired };
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
