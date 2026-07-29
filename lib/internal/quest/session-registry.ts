/**
 * The durable record of which pi sessions are open, which quest each
 * is on, and when each was last open.
 *
 * This module is pure: it shapes records and answers questions about
 * them. Reading and writing them, probing whether a session is still
 * alive and touching the heartbeat all live in the extension's
 * wiring.
 */

import type { ProcessIdentity } from "./process-liveness.js";

/**
 * The terminal surface a session ran in, as recorded.
 *
 * Leaner than a full `TerminalSessionHandle`, and deliberately the
 * same shape the quest frontmatter already persists. The handle's
 * `kind` is descriptive rather than probeable, and a reader
 * reconstitutes it from the driver id, so storing it would only give
 * two copies of one fact the chance to disagree.
 */
export interface RecordedTerminal {
	driverId: string;
	value: string;
	scope?: string;
	hostId?: string;
}

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
	terminal?: RecordedTerminal;
	openedAt: string;
	closedAt?: string;
	/** Why the session ended; absent while it is still running. */
	endReason?: SessionEndReason;
}

/**
 * How a session ended. `quit` means the pi process exited and took
 * its tab with it. `swapped` means the conversation was replaced
 * inside a tab that is still on screen, which is what a reload, a
 * session switch and a fork all do. `died` means no process recorded
 * an ending at all and a later reader found it gone, which is what a
 * crash looks like from the outside.
 */
export type SessionEndReason = "quit" | "swapped" | "died";

/** What a caller knows when a session first loads a quest. */
export interface OpenInput {
	sessionId: string;
	instanceId: string;
	cwd: string;
	questId?: string;
	process?: ProcessIdentity;
	terminal?: RecordedTerminal;
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

/** The end reasons a reader is willing to act on. */
const END_REASONS: readonly string[] = ["quit", "swapped", "died"];

/**
 * Read a stored value back as a record, or refuse it.
 *
 * A record decides whether a tab is offered back to the user, so a
 * file that has been hand-edited, half-written or produced by a newer
 * version is skipped rather than half-believed. Refusing costs one
 * forgotten session; trusting a malformed one can hide a recoverable
 * tab or resurrect a closed one.
 */
/**
 * What a session id may contain: the shape pi's own ids take, which
 * is also the shape that is safe as a file name and as a shell word.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export function parseSessionRecord(value: unknown): SessionRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	const required = [v.sessionId, v.instanceId, v.cwd, v.openedAt];
	if (!required.every((field) => typeof field === "string" && field !== "")) {
		return undefined;
	}
	// Restore resumes a session by typing its id into a live shell, and
	// a record is just a file, so anything that can write one could
	// otherwise reach the terminal through it. Refuse here rather than
	// escaping downstream: an id that is not an identifier is not a
	// record, and one check at the door beats remembering to quote at
	// every use. The same shape keeps the id usable as a file name.
	if (!SAFE_SESSION_ID.test(v.sessionId as string)) return undefined;
	if (v.quest !== undefined && typeof v.quest !== "string") return undefined;
	if (v.closedAt !== undefined && typeof v.closedAt !== "string") {
		return undefined;
	}
	if (
		v.endReason !== undefined &&
		!END_REASONS.includes(v.endReason as string)
	) {
		return undefined;
	}
	if (v.previousQuests !== undefined && !isStringMap(v.previousQuests)) {
		return undefined;
	}
	return value as SessionRecord;
}

/** Whether a value is a flat object of string values. */
function isStringMap(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((entry) => typeof entry === "string");
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
 * A close a reader wrote after finding the process gone carries the
 * same shape but not the same authority, so it reports approximate
 * too: nobody watched that session end.
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
	if (record.closedAt) {
		return { at: record.closedAt, exact: record.endReason !== "died" };
	}
	return { at: observation.heartbeatAt ?? record.openedAt, exact: false };
}

/**
 * Stamp a record as ended. Closing an already-closed record leaves it
 * alone: a late heartbeat or a second shutdown must not move the
 * moment the session actually ended, which is the timestamp every
 * recency ordering is built on.
 */
/**
 * A runnable line per session, to be pasted into a shell.
 *
 * Everything interpolated is quoted, because all of it comes from
 * disk: a working directory is whatever the filesystem allows, and a
 * record can be hand-edited. A line the user is invited to paste is
 * not the place to trust either.
 */
export function restoreRecipe(records: readonly SessionRecord[]): string[] {
	return records.map((record) => {
		const quest = record.quest ? `  # ${commentSafe(record.quest)}` : "";
		return `(cd ${shellSingleQuote(record.cwd)} && pi --session ${shellSingleQuote(record.sessionId)})${quest}`;
	});
}

/**
 * Wrap a value in single quotes for safe shell interpolation. An
 * embedded single quote is closed, escaped and reopened (`'\''`), the
 * standard POSIX idiom, so the value cannot break out of the quoting.
 */
export function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Flatten a value for a trailing shell comment. A newline would end
 * the comment and turn the rest of the recipe into a live command, so
 * control characters are collapsed to a space.
 */
function commentSafe(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * The sessions worth offering back, most recently lost first.
 *
 * Only a session that ended without anyone asking qualifies. Quitting
 * a tab is an instruction rather than an accident, and a swap
 * replaced the conversation in a tab that is still on screen, so
 * neither leaves anything to bring back. Offering those anyway is how
 * restore came to propose tabs nobody had lost, which taught people
 * to distrust the whole list.
 *
 * A session still in the open set is either running or waiting for a
 * reader to notice it is not. Either way it is not yet known to be
 * lost, and a reader that probes it settles the question before this
 * is asked.
 */
export function restorable(records: readonly SessionRecord[]): SessionRecord[] {
	return records
		.filter((record) => record.endReason === "died" && record.closedAt)
		.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
}

/**
 * Put a closed record back in the open set, under the identity of the
 * process that has resumed it.
 *
 * Restore offers back the sessions that died. One the user has
 * already brought back has to stop being offered, and the only thing
 * that says so is its record rejoining the open set.
 *
 * The new identity replaces the old rather than merging with it. The
 * recorded pid belongs to a process that is gone, and after a reboot
 * to whatever inherited the number, so probing it would answer about
 * a stranger. Where the resuming process could not capture an
 * identity the field is dropped for the same reason: absent reads as
 * cannot say, which is true, while a stale value reads as fact.
 *
 * The opening moment stays put. Resuming continues a session rather
 * than starting one.
 */
export function reopenRecord(
	record: SessionRecord,
	input: {
		instanceId: string;
		process?: ProcessIdentity;
		terminal?: RecordedTerminal;
	},
): SessionRecord {
	const { closedAt, endReason, process, terminal, ...rest } = record;
	return {
		...rest,
		instanceId: input.instanceId,
		...(input.process ? { process: input.process } : {}),
		...(input.terminal ? { terminal: input.terminal } : {}),
	};
}

export function closeRecord(
	record: SessionRecord,
	reason: SessionEndReason,
	now: Date,
): SessionRecord {
	if (record.closedAt) return record;
	return { ...record, closedAt: now.toISOString(), endReason: reason };
}
