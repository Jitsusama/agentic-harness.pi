/**
 * A running session's own record over its life: opened or moved as it
 * starts or switches quest, re-dated on a heartbeat, handed to the
 * session it switches into, and closed for the reason it ended.
 *
 * The pure store in `lib/internal/quest/sessions/session-registry` shapes
 * records and answers questions about them. The rest of the live
 * wiring sits in `sessions/`: the records on disk, the signal stamp,
 * what restore offers and reopening it. The extension's entry imports
 * a few of those through here, re-exported below until it imports them
 * from their own files.
 */

import { sessionSlot } from "../../lib/core/session/slot.ts";
import {
	namesAnotherProcess,
	openRecord,
	reopenRecord,
	type SessionEndReason,
	type SessionRecord,
	switchQuest,
	wronglyEnded,
} from "../../lib/internal/quest/sessions/session-registry.ts";
import {
	type CarriedEnvironment,
	carriedEnvironment,
} from "../../lib/internal/session/carried-environment.ts";
import { sessionLogHeader } from "../../lib/internal/session/log-header.ts";
import { readRecord, saveRecord, touchHeartbeat } from "./sessions/records.ts";
import {
	followSessionForSignals,
	setSignalStampSession,
} from "./sessions/signal-stamp.ts";

export { recordSessionEnd } from "./sessions/records.ts";
export {
	lostSessionCount,
	refreshRestoreFile,
	settleMoveNote,
} from "./sessions/restore.ts";
export {
	followHostStamps,
	setSignalStampSession,
} from "./sessions/signal-stamp.ts";

/**
 * How often a running session re-dates its own record.
 *
 * This only bounds how far out a crash death can be dated, since
 * nothing consults the heartbeat to decide whether a session is
 * alive. A minute is far finer than any ordering needs and cheap
 * enough to disappear: the touch is metadata only.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * The running heartbeat, at most one per process: kept on the process
 * rather than the module, because a session switch can load this file
 * afresh, and a timer the old copy started would then beat on after
 * the new copy stopped its own, re-dating a session that had ended.
 */
const HEARTBEAT_SLOT = "agentic-harness.quest-workflow.heartbeat";

function heartbeatSlot(): { timer?: ReturnType<typeof setInterval> } {
	return sessionSlot<{ timer?: ReturnType<typeof setInterval> }>(
		HEARTBEAT_SLOT,
		undefined,
		() => ({}),
	);
}

/**
 * Start re-dating this session's record on a timer.
 *
 * The timer is unref'd, so it never holds the process open on its
 * own: a pi that is otherwise finished must still be allowed to
 * exit. Starting twice replaces the first timer rather than running
 * two. In a host each conversation beats for its own record, since
 * only it can put that record right when a reader got it wrong.
 */
export function startHeartbeat(
	sessionId: string,
	intervalMs: number = HEARTBEAT_INTERVAL_MS,
	check?: () => void,
): void {
	stopHeartbeat();
	const timer = setInterval(() => {
		touchHeartbeat(sessionId);
		check?.();
	}, intervalMs);
	timer.unref?.();
	heartbeatSlot().timer = timer;
}

/**
 * Put this session's record right when a reader got it wrong: closed
 * as died or vanished while this process runs it, or naming another
 * process. Only the running session can know either, and it says so
 * on its next heartbeat.
 */
export function keepRecordTrue(input: OnQuestInput): void {
	let record: SessionRecord | undefined;
	try {
		record = readRecord(input.sessionId);
	} catch {
		// An unreadable record is put right by the next tick, or by the
		// session's next start.
		return;
	}
	if (record === undefined) return;
	const wrong =
		(record.closedAt !== undefined && wronglyEnded(record)) ||
		namesAnotherProcess(record, input.process);
	if (wrong) recordSession(input);
}

/**
 * Stop re-dating. Call this before stamping a record closed: a tick
 * that lands afterwards would touch the file again and re-date a
 * session that has already ended.
 */
export function stopHeartbeat(): void {
	const slot = heartbeatSlot();
	if (!slot.timer) return;
	clearInterval(slot.timer);
	delete slot.timer;
}

/** What the caller knows about a session it is recording. */
export interface OnQuestInput {
	sessionId: string;
	cwd: string;
	/** The quest it is on, absent for a tab with none loaded. */
	questId?: string;
	instanceId: string;
	process?: SessionRecord["process"];
	terminal?: SessionRecord["terminal"];
	/** What it was started with that says how its commands run. */
	env?: CarriedEnvironment;
}

/**
 * What this pi was started with that says how its commands run, in the
 * fence and through the spawner, for its session's record, so the
 * launcher reopens it the same way after a reboot.
 */
export function startedWith(env: NodeJS.ProcessEnv = process.env): {
	env?: CarriedEnvironment;
} {
	const carried = carriedEnvironment(env);
	return carried ? { env: carried } : {};
}

/**
 * Note that a session is running, and on which quest if any, opening
 * its record the first time and moving it thereafter.
 *
 * Every persisted interactive session is recorded, with or without a
 * quest. Recording only on a quest load left out every tab that
 * started with `quest create`, worked without a quest or had just been
 * swapped in by `/new`, and restore then brought back a fraction of
 * what was open. A session that later unloads keeps its record: once a
 * tab is known it stays tracked until it ends, since dropping it would
 * make an open tab disappear from the open set.
 */
export function recordSession(input: OnQuestInput, now = new Date()): void {
	const existing = readRecord(input.sessionId);
	if (existing) {
		// A closed record here means the session was resumed: this
		// process is running a conversation something else ended. Put it
		// back in the open set under our identity, or restore would go on
		// offering a tab the user has already brought back. So is an open
		// one naming another process, as a power-off leaves it: kept, the
		// next reader finds that process gone and calls this one died.
		const resumed =
			existing.closedAt !== undefined ||
			namesAnotherProcess(existing, input.process);
		const live = resumed
			? reopenRecord(existing, {
					instanceId: input.instanceId,
					...(input.process ? { process: input.process } : {}),
					...(input.terminal ? { terminal: input.terminal } : {}),
					...(input.env ? { env: input.env } : {}),
				})
			: startedAs(existing, input.env);
		// A session that reaches this code is running a process that
		// keeps the registry, so it has a shutdown hook and is no longer
		// merely adopted. Leaving the flag on would keep treating its
		// eventual close as unknowable long after it stopped being so.
		const { adopted: _hadNoHook, ...owned } = live;
		saveRecord(input.questId ? switchQuest(owned, input.questId, now) : owned);
		return;
	}
	saveRecord(
		openRecord({
			sessionId: input.sessionId,
			instanceId: input.instanceId,
			cwd: input.cwd,
			...(input.questId ? { questId: input.questId } : {}),
			...(input.process ? { process: input.process } : {}),
			...(input.terminal ? { terminal: input.terminal } : {}),
			...(input.env ? { env: input.env } : {}),
			now,
		}),
	);
}

/**
 * `record`, saying it runs with `env`: this process's own start, which
 * a record it opened before it kept the variables doesn't say yet.
 */
function startedAs(
	record: SessionRecord,
	env: CarriedEnvironment | undefined,
): SessionRecord {
	const { env: _was, ...rest } = record;
	return env ? { ...rest, env } : rest;
}

/**
 * Record a session and keep its record honest for as long as it runs:
 * open or move the record, re-date it on a heartbeat, and stamp it
 * from the signal that takes the tab away. Every path that starts or
 * switches a session goes through this, so none of them can record a
 * session and forget the other two.
 */
export function trackSession(input: OnQuestInput, release?: () => void): void {
	recordSession(input);
	startHeartbeat(input.sessionId, HEARTBEAT_INTERVAL_MS, () =>
		keepRecordTrue(input),
	);
	followSessionForSignals(input.sessionId, release);
}

/**
 * Hand this process's tab to the session it is switching into, when
 * that session's log is already on disk: open the successor's record
 * under this process, keep beating for it, and have a signal stamp it.
 * Returns the successor's id, or undefined when there is no log to
 * hand to, as for `/new`, whose session is written only once used.
 *
 * The successor's own start records it too, finding the record already
 * its own. This covers a switch whose new session never starts: at
 * 12:42:58Z on 2026-10-29 a rollover closed a session and its fresh log
 * got no record, so the power-off eleven minutes later left it out of
 * what restore offers. The quest carries over only when the successor
 * names this session's log as its parent, as a rollover's and a fork's
 * do; a resumed conversation from elsewhere says its own on start.
 */
export function handOverSession(
	from: OnQuestInput & { sessionFile?: string },
	targetSessionFile: string | undefined,
): string | undefined {
	if (!targetSessionFile) return undefined;
	const header = sessionLogHeader(targetSessionFile);
	if (!header || header.id === from.sessionId) return undefined;
	const carriesQuest =
		from.sessionFile !== undefined && header.parentSession === from.sessionFile;
	const successor: OnQuestInput = {
		sessionId: header.id,
		cwd: header.cwd ?? from.cwd,
		instanceId: from.instanceId,
		...(carriesQuest && from.questId ? { questId: from.questId } : {}),
		...(from.process ? { process: from.process } : {}),
		...(from.terminal ? { terminal: from.terminal } : {}),
		...(from.env ? { env: from.env } : {}),
	};
	recordSession(successor);
	startHeartbeat(successor.sessionId, HEARTBEAT_INTERVAL_MS, () =>
		keepRecordTrue(successor),
	);
	setSignalStampSession(successor.sessionId);
	return successor.sessionId;
}

/**
 * How a pi shutdown reason translates to the end of a session record,
 * or undefined when the record should be left alone.
 *
 * Only `quit` takes the tab with it. A `reload` keeps the same
 * session running in the same process, so nothing has ended at all.
 * The rest replace the conversation inside a tab that is still on
 * screen, which ends the session but not the tab, and the successor
 * opens its own record carrying the same instance id. A quit the
 * session took to park (`parking`) is a park, since its holder keeps
 * its window and starts it again when something needs it.
 */
export function endReasonForShutdown(
	reason: string | undefined,
	parking = false,
): SessionEndReason | undefined {
	if (reason === "reload") return undefined;
	if (reason === "quit") return parking ? "parked" : "quit";
	return "swapped";
}
