/**
 * The durable record of which pi sessions are open, which quest each
 * is on, and when each was last open.
 *
 * This module is pure: it shapes records and answers questions about
 * them. Reading and writing them, probing whether a session is still
 * alive and touching the heartbeat all live in the extension's
 * wiring.
 */

import type { TerminalSessionHandle } from "../../terminal/types.js";
import type { ProcessIdentity } from "./process-liveness.js";

/** One pi session, as recorded by the process that owns it. */
export interface SessionRecord {
	sessionId: string;
	/** The pi process the session ran in; a tab's sessions share it. */
	instanceId: string;
	cwd: string;
	/** The quest the session is on now, absent once it has unloaded. */
	quest?: string;
	/**
	 * Quests the session has since left, each against the moment it
	 * left. A quest reads its own entry here rather than the session's
	 * overall recency, so it dates a session by when it was last doing
	 * that quest's work.
	 */
	previousQuests?: Record<string, string>;
	process?: ProcessIdentity;
	terminal?: TerminalSessionHandle;
	openedAt: string;
	closedAt?: string;
	/** Why the session ended; absent while it is still running. */
	endReason?: SessionEndReason;
}

/**
 * How a session ended. `quit` means the pi process exited and took
 * its tab with it. `swapped` means the conversation was replaced
 * inside a tab that is still on screen, which is what a reload, a
 * session switch and a fork all do.
 */
export type SessionEndReason = "quit" | "swapped";

/** What a caller knows when a session first loads a quest. */
export interface OpenInput {
	sessionId: string;
	instanceId: string;
	cwd: string;
	questId?: string;
	process?: ProcessIdentity;
	terminal?: TerminalSessionHandle;
	now: Date;
}

/**
 * Mint a record for a session that has just loaded a quest. Identity
 * a session could not capture is left off the record entirely rather
 * than stored empty, because the readers treat an absent dimension as
 * "cannot say" and an empty one would read as a mismatch.
 */
export function openRecord(input: OpenInput): SessionRecord {
	return {
		sessionId: input.sessionId,
		instanceId: input.instanceId,
		cwd: input.cwd,
		...(input.questId ? { quest: input.questId } : {}),
		...(input.process ? { process: input.process } : {}),
		...(input.terminal ? { terminal: input.terminal } : {}),
		openedAt: input.now.toISOString(),
	};
}

/** Milliseconds in a day, for the retention window. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Split records into those worth keeping and those old enough to
 * forget. Only a session we can prove ended is ever forgotten: a
 * record with no close stamp is either still running or crashed and
 * not yet repaired, and dropping it would lose a tab that could still
 * have been reopened. That makes the reader-side repair, which stamps
 * a record whose process a probe found gone, the thing that lets this
 * window ever apply.
 */
export function pruneRecords(
	records: readonly SessionRecord[],
	opts: { now: Date; retentionDays: number },
): { kept: SessionRecord[]; dropped: SessionRecord[] } {
	const cutoff = opts.now.getTime() - opts.retentionDays * DAY_MS;
	const kept: SessionRecord[] = [];
	const dropped: SessionRecord[] = [];
	for (const record of records) {
		const closed = record.closedAt ? Date.parse(record.closedAt) : undefined;
		if (closed !== undefined && !Number.isNaN(closed) && closed < cutoff) {
			dropped.push(record);
		} else {
			kept.push(record);
		}
	}
	return { kept, dropped };
}

/**
 * Move a session to a different quest, or to none, stamping the quest
 * it is leaving with the moment it left. Returning to a quest clears
 * its old departure, since it is current again and the record should
 * not claim it both is and was.
 */
export function switchQuest(
	record: SessionRecord,
	questId: string | undefined,
	now: Date,
): SessionRecord {
	if (record.quest === questId) return record;
	const previous = { ...record.previousQuests };
	if (record.quest) previous[record.quest] = now.toISOString();
	if (questId) delete previous[questId];
	const next: SessionRecord = { ...record };
	if (questId) next.quest = questId;
	else delete next.quest;
	if (Object.keys(previous).length > 0) next.previousQuests = previous;
	else delete next.previousQuests;
	return next;
}

/**
 * When a session was last open on one particular quest, or undefined
 * when it was never on it.
 *
 * The quest it is on now is dated by the session itself, so a live
 * session reads as open. A quest it has left is dated by the leaving,
 * which is what stops a still-running session from making every quest
 * it ever touched look current.
 */
export function lastOpenOnQuest(
	record: SessionRecord,
	questId: string,
	observation: RecordObservation,
	now: Date,
): LastOpen | undefined {
	if (record.quest === questId) return lastOpenAt(record, observation, now);
	const left = record.previousQuests?.[questId];
	return left ? { at: left, exact: true } : undefined;
}

/** What a reader observed about a record when it looked. */
export interface RecordObservation {
	/** Whether a probe found the session open right now. */
	live: boolean;
	/** When the record was last touched, as an ISO string. */
	heartbeatAt?: string;
}

/** When a session was last open, and whether we can be exact. */
export interface LastOpen {
	at: string;
	exact: boolean;
}

/**
 * When a session was last open.
 *
 * Three sources, in descending order of how much they can be
 * trusted. A probe that found the session alive means it is open now.
 * A close stamp is the moment its own process recorded it ending, and
 * outranks the heartbeat because the record is touched as the process
 * winds down, so an mtime a moment past the close is normal. Anything
 * else died without saying so, and the last time we saw it alive is
 * the best answer there is, flagged as approximate.
 *
 * Deliberately not a source: how recently the session's log was
 * written. That measures when someone last typed, which is the thing
 * this whole record exists to stop standing in for being open.
 */
export function lastOpenAt(
	record: SessionRecord,
	observation: RecordObservation,
	now: Date,
): LastOpen {
	if (observation.live) return { at: now.toISOString(), exact: true };
	if (record.closedAt) return { at: record.closedAt, exact: true };
	return { at: observation.heartbeatAt ?? record.openedAt, exact: false };
}

/**
 * Stamp a record as ended. Closing an already-closed record leaves it
 * alone: a late heartbeat or a second shutdown must not move the
 * moment the session actually ended, which is the timestamp every
 * recency ordering is built on.
 */
export function closeRecord(
	record: SessionRecord,
	reason: SessionEndReason,
	now: Date,
): SessionRecord {
	if (record.closedAt) return record;
	return { ...record, closedAt: now.toISOString(), endReason: reason };
}
