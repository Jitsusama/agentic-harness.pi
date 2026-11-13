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
import { homedir } from "node:os";
import { join } from "node:path";
import {
	hosted,
	isSessionStamp,
	SESSION_STAMP_EVENT,
} from "../../lib/core/session/host.ts";
import { sessionSlot } from "../../lib/core/session/slot.ts";
import { machineBooted } from "../../lib/internal/booted.ts";
import { thisMachine } from "../../lib/internal/machine.ts";
import { sessionsDir, stateDir } from "../../lib/internal/paths.ts";
import { takeUpCarried } from "../../lib/internal/quest/carried.ts";
import { parseQuestFrontMatter } from "../../lib/internal/quest/frontmatter.ts";
import {
	type HandedPlace,
	type HandedSession,
	launcherTakes,
} from "../../lib/internal/quest/hand-over.ts";
import { atomicWriteFile } from "../../lib/internal/quest/io.ts";
import { sessionRegistryDir } from "../../lib/internal/quest/loaded.ts";
import { windowWorkspaceOf } from "../../lib/internal/quest/orchestration.ts";
import {
	currentBootToken,
	localProcessDeps,
	probeProcess,
} from "../../lib/internal/quest/process-liveness.ts";
import { extractTitle } from "../../lib/internal/quest/quest-doc.ts";
import {
	SESSION_MARK,
	type Settled,
} from "../../lib/internal/quest/reopen-in-place.ts";
import {
	bootEndedBefore,
	type RestoreEntry,
	releasedEntry,
	restoreFileOf,
	restoreFilePath,
	writeRestoreFile,
} from "../../lib/internal/quest/restore-file.ts";
import { indexSessionFiles } from "../../lib/internal/quest/session-liveness.ts";
import {
	carriedOnElsewhere,
	closeRecord,
	hostKeeps,
	type LastBootSessions,
	lastBootSessions,
	markSignalled,
	namesAnotherProcess,
	openRecord,
	parseSessionRecord,
	pruneRecords,
	recentlyClosed,
	reopenCommand,
	reopenRecord,
	restorable,
	type SessionEndReason,
	type SessionRecord,
	startedAgain,
	switchQuest,
	wasLost,
	wronglyEnded,
} from "../../lib/internal/quest/session-registry.ts";
import {
	openInSessionsKitty,
	sessionsKittyRuns,
} from "../../lib/internal/quest/sessions-kitty.ts";
import { isLiveStatus } from "../../lib/internal/quest/status.ts";
import {
	readWindowsNote,
	windowsNotePath,
	windowsToReopen,
} from "../../lib/internal/quest/windows-elsewhere.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace-root.ts";
import {
	type CarriedEnvironment,
	carriedEnvironment,
} from "../../lib/internal/session/carried-environment.ts";
import {
	attachWords,
	rosterHolds,
} from "../../lib/internal/session/host-holds.ts";
import { sessionLogHeader } from "../../lib/internal/session/log-header.ts";
import {
	moveFolder,
	readMoveNote,
	readMoveNotes,
	removeMoveNote,
} from "../../lib/internal/session/move.ts";
import { isParking, PARKING } from "../../lib/internal/session/park.ts";
import { questAddress } from "../../lib/mesh/address.ts";
import type { QuestSession } from "../../lib/quest/index.ts";
import type { QuestFrontMatter } from "../../lib/quest/types.ts";
import {
	describePlan,
	type OpenOptions,
	openTerminals,
	type TerminalLayout,
	type WindowPlace,
} from "../../lib/terminal/index.ts";
import { count } from "../../lib/ui/count.ts";

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

/** What the signal stamp needs from the world, replaceable in tests. */
export interface SignalStampDeps {
	now: () => Date;
	schedule: (fire: () => void, delayMs: number) => void;
	raise: (signal: NodeJS.Signals) => void;
}

/**
 * The signals that mean the terminal or the machine took the process
 * away. SIGHUP is a closed tab, a terminal program that quit or died
 * under a busy tab; SIGTERM is what a shutdown sends. A deliberate
 * `/quit` sends neither, which is what makes them worth listening for.
 */
const TERMINATING_SIGNALS: readonly NodeJS.Signals[] = ["SIGHUP", "SIGTERM"];

/**
 * How long a dying process gets to finish on its own before the
 * signal is sent again. pi's own shutdown normally ends the process
 * within a second of a hang-up, so this only matters when nothing else
 * is going to.
 */
const REFIRE_GRACE_MS = 3_000;

/**
 * The stamp's state, held on `globalThis` rather than in this module.
 * A reload imports the extension afresh, and the listeners have to be
 * installed once per process, not once per import, or a second copy
 * would stamp and re-raise alongside the first.
 */
interface SignalStampSlot {
	sessionId?: string;
	/** Run after the stamp, to release the session wherever else it shows. */
	release?: () => void;
	listeners?: Map<NodeJS.Signals, () => void>;
}

const SIGNAL_STAMP_SLOT = "agentic-harness.quest-workflow.signal-stamp";

function signalStampSlot(): SignalStampSlot {
	return sessionSlot<SignalStampSlot>(SIGNAL_STAMP_SLOT, undefined, () => ({}));
}

/**
 * Say which session a signal should stamp. A session switch keeps the
 * process and changes the session, so this follows the session rather
 * than being fixed when the listeners go in.
 */
export function setSignalStampSession(sessionId: string | undefined): void {
	const slot = signalStampSlot();
	if (sessionId) slot.sessionId = sessionId;
	else delete slot.sessionId;
	// A release belongs to the session it was given for.
	delete slot.release;
}

const liveSignalStampDeps: SignalStampDeps = {
	now: () => new Date(),
	schedule: (fire, delayMs) => {
		// Unref'd, so it only fires if something else is holding the
		// process open. A process that exits on its own never sees it.
		setTimeout(fire, delayMs).unref?.();
	},
	raise: (signal) => process.kill(process.pid, signal),
};

/**
 * Listen for the signals that take a session away, and stamp its
 * record `signalled` when one arrives.
 *
 * pi reports these signals as an ordinary quit, and whether its
 * shutdown hook gets far enough to stamp that is a race against the
 * process exiting. A listener of our own runs in the same synchronous
 * dispatch as pi's, before anything can exit, so it is the one place
 * the difference between a signal and a deliberate quit can be
 * recorded reliably. The write is synchronous for the same reason.
 *
 * Listening for SIGHUP switches off Node's default exit, so after the
 * stamp the listeners remove themselves and the signal is re-raised
 * after a grace period. If pi has already exited, nothing happens. If
 * it is still around, the signal now reaches whatever would have had
 * it without us, so installing this can never keep alive a process
 * that should have died.
 */
export function installSignalStamp(
	deps: SignalStampDeps = liveSignalStampDeps,
): void {
	if (hosted()) return;
	const slot = signalStampSlot();
	if (slot.listeners) return;
	const listeners = new Map<NodeJS.Signals, () => void>();
	for (const signal of TERMINATING_SIGNALS) {
		listeners.set(signal, () => {
			if (slot.sessionId) {
				stampSignalled(slot.sessionId, deps.now());
				// Best-effort and after the stamp, so a failure here can
				// cost the README but never the record restore reads.
				try {
					slot.release?.();
				} catch {}
			}
			removeSignalStamp();
			deps.schedule(() => deps.raise(signal), REFIRE_GRACE_MS);
		});
	}
	for (const [signal, listener] of listeners) process.on(signal, listener);
	slot.listeners = listeners;
}

/**
 * Make this session the one a SIGHUP or SIGTERM stamps, listening if
 * nothing is yet. Called wherever a session's record is opened, so
 * the launch path and a later `quest load` are covered alike.
 *
 * `release` runs synchronously straight after the stamp. pi exits
 * moments after the signal, usually before its own shutdown hook
 * gets far, so anything else that must record the session's end, the
 * quest README above all, has to happen here to happen at all.
 */
export function followSessionForSignals(
	sessionId: string,
	release?: () => void,
): void {
	setSignalStampSession(sessionId);
	if (release) signalStampSlot().release = release;
	installSignalStamp();
}

/** Stop listening, leaving the session the stamp follows in place. */
export function removeSignalStamp(): void {
	const slot = signalStampSlot();
	if (!slot.listeners) return;
	for (const [signal, listener] of slot.listeners) {
		process.off(signal, listener);
	}
	delete slot.listeners;
}

/**
 * Mark a session's record as ended by a signal, if it has one. A
 * session the registry never recorded is left unrecorded: inventing a
 * record at the moment of death would offer back a tab nobody tracked.
 */
function stampSignalled(sessionId: string, now: Date): void {
	const record = readRecord(sessionId);
	if (!record) return;
	const stamped = markSignalled(record, now);
	if (stamped !== record) saveRecord(stamped);
}

/**
 * Follow only this conversation's host endings, disposing the hook on
 * reload. A host parks a conversation by stopping it as a host stop
 * does, so one stopped once it said it parks (park-workflow's PARKING)
 * is recorded as parked, as plain pi's park is, rather than as taken
 * away. Each start follows anew, so a park said before it is forgotten.
 */
export function followHostStamps(
	bus: { on(channel: string, listener: (data: unknown) => void): () => void },
	session: string,
	release: () => void,
): () => void {
	let parking = false;
	const offParking = bus.on(PARKING, (data) => {
		if (isParking(data) && data.session === session) parking = true;
	});
	const offStamps = bus.on(SESSION_STAMP_EVENT, (data) => {
		if (!isSessionStamp(data) || data.session !== session) return;
		if (data.how !== "signalled") recordSessionEnd(session, "quit");
		else if (parking) recordSessionEnd(session, "parked");
		else stampSignalled(session, new Date());
		release();
	});
	return () => {
		offParking();
		offStamps();
	};
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
export function restorableSessions(
	saved: (sessionId: string) => boolean = savedSessions(),
): SessionRecord[] {
	const stored = loadRecords();
	observeRecords(stored);
	// Re-read rather than patching the list in place: observing writes
	// the repairs to disk, and the reload is what makes the answer the
	// same one a second reader would get.
	const records = loadRecords().map((entry) => entry.record);
	const kept = keptByHost();
	// A session pi never saved is brought back by starting one in its
	// place, by restore or by hand from its recipe line; once that has
	// happened there is nothing left to offer, and its record goes.
	return restorable(records).filter((record) => {
		// Its host brings it back; a terminal too would be a second writer.
		if (kept(record)) return false;
		if (saved(record.sessionId) || !startedAgain(record, records)) return true;
		forgetRecord(record.sessionId);
		return false;
	});
}

/**
 * What restore offers after a boot: the lost sessions that were running
 * when the last boot ended, and the rest of the lost, only to be named
 * (see `lastBootSessions`).
 */
export function lastBootRestorable(
	saved: (sessionId: string) => boolean = savedSessions(),
	thisBoot: string | undefined = currentBootToken(),
	parentOf: (sessionId: string) => string | undefined = logParents(),
): LastBootSessions {
	const lost = new Set(
		restorableSessions(saved).map((record) => record.sessionId),
	);
	const records = loadRecords().map((entry) => entry.record);
	const hostHas = keptByHost();
	const found = lastBootSessions(records, thisBoot, endedBoot(thisBoot));
	const kept = (list: SessionRecord[]) =>
		list.filter((record) => lost.has(record.sessionId));
	const offered = kept(found.offered);
	const parked = found.parked.filter((record) => !hostHas(record));
	const carried = carriedOnElsewhere(
		[...offered, ...parked],
		records.filter((record) => !record.closedAt),
		parentOf,
	);
	const uncarried = (list: SessionRecord[]) =>
		list.filter((record) => !carried.has(record.sessionId));
	return {
		...found,
		offered: uncarried(offered),
		older: kept(found.older),
		parked: uncarried(parked),
	};
}

/**
 * Each saved session's parent, as its log's header names it: the session
 * a rollover or a fork carried on from. Logs are found once, when this
 * is made, and each header read when asked.
 */
function logParents(): (sessionId: string) => string | undefined {
	const logs = indexSessionFiles(sessionsDir());
	return (sessionId) => {
		const log = logs.get(sessionId);
		const parentLog = log ? sessionLogHeader(log)?.parentSession : undefined;
		return parentLog ? sessionLogHeader(parentLog)?.id : undefined;
	};
}

/**
 * Whether a host has a session, by what its record says or by a host's
 * roster keeping it: a record can still name the plain pi the session
 * moved from, or a host that crashed and takes it up again as it
 * starts. Rosters are read once, when this is made.
 */
export function keptByHost(
	holds: ReadonlyMap<string, string> = rosterHolds(),
): (record: SessionRecord) => boolean {
	return (record) => hostKeeps(record) || holds.has(record.sessionId);
}

/**
 * Rewrite the launcher's restore file from the records as they stand,
 * probing nothing (see lib/internal/quest/restore-file.ts). A session
 * starting calls it, so one reopened drops out of the launcher's list
 * within moments. Best-effort: a file that can't be written leaves the
 * last one in place, which only lists a session already back.
 */
export function refreshRestoreFile(
	questsRoot: string,
	stateHome: string = defaultStateHome(),
): void {
	try {
		const thisBoot = currentBootToken();
		const note = readWindowsNote(windowsNotePath(stateDir("quest-workflow")));
		const file = restoreFileOf(
			loadRecords(),
			thisBoot,
			(questId) => questTitle(questsRoot, questId),
			savedSessions(),
			(lastBoot) => windowsToReopen(note, thisBoot, lastBoot),
			carriedHome(questsRoot),
			endedBoot(thisBoot, stateHome),
			(questId) => questLive(questsRoot, questId),
			releasedHome(questsRoot),
			{
				workspaceOf: workspaceReader(questsRoot),
				parentOf: logParents(),
			},
		);
		writeRestoreFile(restoreFilePath(stateHome), file);
	} catch {
		// The launcher keeps the file it has; the next start writes again.
	}
}

/**
 * The state folder the restore file sits under. An empty XDG_STATE_HOME
 * means the default, as the spec says; read as a path it would write
 * into whatever folder the process stands in.
 */
function defaultStateHome(): string {
	return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

/**
 * The boot this boot already named as the last in the restore file, so
 * every later reading keeps it (see `bootEndedBefore`).
 */
function endedBoot(
	thisBoot: string | undefined,
	stateHome: string = defaultStateHome(),
): string | undefined {
	return bootEndedBefore(restoreFilePath(stateHome), thisBoot, machineBooted());
}

/**
 * The sessions other machines carried here, each placed in pi's store
 * for the folder it reopens in, less any a pi has run here since
 * (lib/internal/quest/carried.ts).
 */
export function carriedHome(questsRoot: string): RestoreEntry[] {
	const ranHere = new Set(loadRecords().map(({ record }) => record.sessionId));
	return takeUpCarried({
		workspaces: questWorkspacesRoot(),
		here: thisMachine(),
		sessions: sessionsDir(),
		known: indexSessionFiles(sessionsDir()),
		quests: questsRoot,
		titleOf: (questId) => questTitle(questsRoot, questId),
	}).filter((entry) => !ranHere.has(entry.id));
}

/**
 * Take away the note a move left for a session now taken up where it
 * runs: in plain pi, since no host is to adopt it; in a host, a
 * release's note, which would have the launcher open it again beside
 * the host. A note for a host stays, for the cutover to take once it
 * sees the session held there.
 */
export function settleMoveNote(
	sessionId: string,
	hosted: boolean,
	folder: string = moveFolder(),
): void {
	if (!hosted || readMoveNote(sessionId, folder)?.to === "pi")
		removeMoveNote(sessionId, folder);
}

/**
 * The sessions their hosts let go to plain pi, from the notes their
 * conversations left as they closed (lib/internal/session/move.ts).
 * One a host keeps again is left out, since opening it here would give
 * its log a second writer.
 */
export function releasedHome(
	questsRoot: string,
	folder: string = moveFolder(),
	kept: () => ReadonlyMap<string, string> = rosterHolds,
): RestoreEntry[] {
	const notes = readMoveNotes(folder).filter((note) => note.to === "pi");
	const holds = notes.length > 0 ? kept() : new Map<string, string>();
	return notes
		.filter((note) => !holds.has(note.session))
		.map((note) => releasedEntry(note, (id) => questTitle(questsRoot, id)));
}

/** A quest's title from its README, or nothing when it can't be read. */
function questTitle(questsRoot: string, questId: string): string | undefined {
	try {
		return extractTitle(
			readFileSync(join(questsRoot, questId, "README.md"), "utf8"),
		);
	} catch {
		// A quest folder gone or unreadable: the entry falls back to its folder.
		return undefined;
	}
}

/**
 * The workspace, by name, a quest's sessions open their windows on
 * (windowWorkspaceOf), each README read once however many sessions and
 * orchestrations name it.
 */
function workspaceReader(
	questsRoot: string,
): (questId: string) => string | undefined {
	const read = new Map<string, QuestFrontMatter | undefined>();
	const frontMatter = (questId: string) => {
		if (!read.has(questId))
			read.set(questId, questFrontMatter(questsRoot, questId));
		return read.get(questId);
	};
	return (questId) => {
		const workspace = windowWorkspaceOf(questId, frontMatter);
		return workspace ? questAddress(workspace) : undefined;
	};
}

/** A quest's front matter from its README, or nothing when unreadable. */
function questFrontMatter(
	questsRoot: string,
	questId: string,
): QuestFrontMatter | undefined {
	try {
		return parseQuestFrontMatter(
			readFileSync(join(questsRoot, questId, "README.md"), "utf8"),
		)?.frontMatter;
	} catch {
		// A quest folder gone or unreadable: its sessions get no workspace.
		return undefined;
	}
}

/**
 * Whether a quest is still live, by its README's status: one concluded
 * or retired is not. A quest that can't be read counts as live, since
 * nothing says its work is done.
 */
function questLive(questsRoot: string, questId: string): boolean {
	let readme: string;
	try {
		readme = readFileSync(join(questsRoot, questId, "README.md"), "utf8");
	} catch {
		// A quest folder gone or unreadable says nothing of its status.
		return true;
	}
	return isLiveStatus(parseQuestFrontMatter(readme)?.frontMatter.status);
}

/**
 * Which sessions pi has saved, and so can resume, read from its session
 * store once.
 *
 * A store that holds no session at all, or cannot be read, says nothing
 * about any of them: a pi keeping its sessions elsewhere would look
 * like one that saved none, and starting a saved session afresh would
 * lose it. Then every session counts as saved, as it did before.
 */
export function savedSessions(): (sessionId: string) => boolean {
	const index = indexSessionFiles(sessionsDir());
	if (index.size === 0) return () => true;
	return (sessionId) => index.has(sessionId);
}

/**
 * How far back restore looks for sessions closed on purpose. A day
 * covers the evening's tabs the next morning, which is the recovery
 * this exists for, without dredging up last week.
 */
const RECENTLY_CLOSED_HOURS = 24;

/**
 * The sessions closed on purpose within the last day, most recent
 * first. Reads without probing, so ask after `restorableSessions`,
 * which has already settled what the open records really are.
 */
export function recentlyClosedSessions(now = new Date()): SessionRecord[] {
	const kept = keptByHost();
	return recentlyClosed(
		loadRecords()
			.map((entry) => entry.record)
			.filter((record) => !kept(record)),
		{ now, withinHours: RECENTLY_CLOSED_HOURS },
	);
}

/**
 * How many sessions are recorded as lost, without probing anything.
 *
 * For the start-up hint, which must stay cheap: the hard rule is that
 * starting a session never shells out to inspect history. A record
 * already closed says what it is without asking the operating system,
 * so a crash nobody has noticed yet is not counted here. It becomes
 * visible the first time something reads the registry properly, which
 * is what `quest reopen-sessions` does.
 */
export function lostSessionCount(): number {
	const kept = keptByHost();
	return loadRecords().filter(({ record }) => wasLost(record) && !kept(record))
		.length;
}

/** What happened when restore tried to reopen the lost sessions. */
export interface ReopenOutcome {
	/** Sessions seen running again: their record is back in the open set. */
	reopened: string[];
	/**
	 * Sessions pi never saved, so a fresh pi was started on their quest
	 * in their place, and seen running. Counted among those reopened.
	 */
	fresh: { sessionId: string; quest?: string }[];
	/** Sessions whose terminal opened but which had not checked in yet. */
	unconfirmed: string[];
	failed: { sessionId: string; reason: string }[];
	/** Sessions held parked, woken in their own holder and window. */
	woken: string[];
	/** Sessions a holder was found running, so nothing was opened. */
	running: string[];
	/** Sessions a host holds, so nothing was opened: how to reach each. */
	hosted: { sessionId: string; host: string; attach: string[] }[];
	/** The line saying what the terminals were opened through. */
	used?: string;
	/** What the person should know, once each. */
	notes: string[];
	/** On a dry run, what would have been done, and nothing was. */
	planned?: boolean;
}

/**
 * How long restore waits for reopened sessions to say they are
 * running. A pi starts in a few seconds, and a dozen starting at once
 * on a loaded machine take longer, so the wait is generous; it is the
 * difference between reporting a session back and reporting a command
 * sent.
 */
export const REOPEN_CONFIRM_MS = 30_000;

/**
 * How long after one session's terminal is begun the next may be. At
 * 17:50 on 30 October six were reopened four at once, and every pi
 * starting together is the load Joel had said he'd rather wait out:
 * "about a second or two between each individual launch".
 */
export const REOPEN_PACE_MS = 2_000;

/** How often the records are read while waiting. */
const REOPEN_POLL_MS = 250;

/**
 * Reopen lost sessions, one terminal surface each, and report which
 * came back.
 *
 * The terminal library runs each resume line under the person's own
 * startup files: typed into a login shell where the terminal can be
 * typed into, through `$SHELL -l -i -c` where it cannot. Handed to a
 * terminal directly the line would run without them, which skips what
 * puts the right pi on PATH; that is what made the first manual
 * recovery take an hour. Tabs with no window to hold them are gathered
 * into one new window.
 *
 * A session counts as reopened only once its pi has started and put
 * its record back in the open set. One whose terminal opened but which
 * has not checked in by the end of the wait is reported as such, so a
 * command sent is never reported as a session restored.
 *
 * A session pi never saved has nothing to resume, so a fresh pi is
 * started on its quest instead (see `reopenCommand`). It counts as
 * back once a session in its place is running, and its record is then
 * forgotten, since the new session carries everything it held.
 *
 * Given `handOver`, the saved sessions go first to the desktop's
 * launcher, which reopens them one at a time, each back where it sat
 * (hand-over.ts). What it doesn't take, or every one when it doesn't
 * answer, is opened here as above, and so is every one pi never saved.
 */
export async function reopenLostSessions(
	records: readonly SessionRecord[],
	options: OpenOptions & {
		readonly layout?: TerminalLayout;
		readonly confirmMs?: number;
		/** How long between beginning one terminal and the next. */
		readonly paceMs?: number;
		readonly saved?: (sessionId: string) => boolean;
		/** Hands sessions to the launcher, answering how many it took. */
		readonly handOver?: (
			sessions: readonly HandedSession[],
		) => Promise<number | undefined>;
		/**
		 * Settles each session first: one a holder runs is left, one held
		 * parked is woken there, and the windows a dead one left are closed
		 * (reopen-in-place.ts).
		 */
		readonly settle?: (sessions: readonly string[]) => Promise<Settled>;
		/** Where each session's window goes under niri. */
		readonly placeOf?: (record: SessionRecord) => WindowPlace | undefined;
		/** The orchestrator, workspace and title each window is placed by. */
		readonly handedPlaceOf?: (record: SessionRecord) => HandedPlace;
	} = {},
): Promise<ReopenOutcome> {
	const {
		layout,
		confirmMs = REOPEN_CONFIRM_MS,
		paceMs = REOPEN_PACE_MS,
		saved = savedSessions(),
		handOver,
		settle,
		placeOf,
		handedPlaceOf = () => ({}),
		...open
	} = options;
	const outcome: ReopenOutcome = {
		reopened: [],
		fresh: [],
		unconfirmed: [],
		failed: [],
		woken: [],
		running: [],
		hosted: [],
		notes: [],
	};
	const settled =
		settle && !open.dryRun
			? await settle(records.map((record) => record.sessionId))
			: undefined;
	if (settled) {
		for (const { session, hold } of settled.hosted) {
			outcome.hosted.push({
				sessionId: session,
				host: hold.key,
				attach: attachWords(hold, session),
			});
		}
		outcome.woken.push(...settled.woken);
		outcome.running.push(...settled.running);
		for (const sessionId of settled.parked) {
			outcome.failed.push({
				sessionId,
				reason:
					"it is held parked, and its holder can't be woken from here; a key in its window wakes it",
			});
		}
		if (settled.closed > 0) {
			outcome.notes.push(
				`closed ${count(settled.closed, "window")} a dead session had left with no pi in it`,
			);
		}
	}
	const toOpen = settled
		? records.filter((record) => settled.reopen.includes(record.sessionId))
		: records;
	const handed =
		handOver && !open.dryRun
			? await handedToLauncher(toOpen, saved, handOver, handedPlaceOf)
			: [];
	const opened: SessionRecord[] = [...handed];
	const left = toOpen.filter((record) => !handed.includes(record));
	// Those the launcher would have opened but didn't take go where it
	// opens its own, the desktop's sessions kitty (sessions-kitty.ts).
	const inSessionsKitty =
		handOver && !open.dryRun && sessionsKittyRuns() ? left : [];
	for (const record of inSessionsKitty) {
		try {
			await openInSessionsKitty({
				cwd: record.cwd,
				...reopenCommand(record, saved(record.sessionId)),
			});
			opened.push(record);
		} catch (error) {
			outcome.failed.push({
				sessionId: record.sessionId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (inSessionsKitty.length > 0) outcome.used ??= SESSIONS_KITTY_USED;
	const here = left.filter((record) => !inSessionsKitty.includes(record));
	const outcomes = await openTerminals(
		here.map((record) => {
			const window = placeOf?.(record);
			return {
				...(layout ? { layout } : {}),
				cwd: record.cwd,
				...reopenCommand(record, saved(record.sessionId)),
				// Its window closes with its pi, and says whose it was.
				endsWithCommand: true,
				marks: { [SESSION_MARK]: record.sessionId },
				...(window ? { window } : {}),
			};
		}),
		{ ...open, paceMs },
	);
	outcomes.forEach((result, index) => {
		const record = here[index];
		if (!record) return;
		if (!result.ok) {
			outcome.failed.push({
				sessionId: record.sessionId,
				reason: result.error,
			});
			return;
		}
		outcome.used ??= describePlan(result.plan);
		for (const note of result.notes) {
			if (!outcome.notes.includes(note)) outcome.notes.push(note);
		}
		if (result.how === "planned") outcome.planned = true;
		else if (result.how === "printed") {
			outcome.failed.push({
				sessionId: record.sessionId,
				reason: "no terminal could be opened",
			});
		} else opened.push(record);
	});
	if (handed.length > 0) {
		outcome.used = outcome.used
			? `${LAUNCHER_USED}, and ${outcome.used}`
			: LAUNCHER_USED;
	}
	if (outcome.planned) return outcome;
	// The launcher waits for each window before the next, so each it took
	// adds its pace to the wait.
	const back = await awaitCheckIn(
		opened,
		saved,
		confirmMs + handed.length * paceMs,
	);
	for (const record of opened) {
		const id = record.sessionId;
		if (!back.has(id)) outcome.unconfirmed.push(id);
		else if (saved(id)) outcome.reopened.push(id);
		else {
			forgetRecord(id);
			outcome.fresh.push({
				sessionId: id,
				...(record.quest ? { quest: record.quest } : {}),
			});
		}
	}
	return outcome;
}

/** How restore says it opened the sessions the launcher took. */
const LAUNCHER_USED = "the launcher, each where it sat";

/** How the sessions opened in the desktop's sessions kitty are said. */
const SESSIONS_KITTY_USED = "the desktop's sessions kitty";

/**
 * The records the launcher took: the saved ones it accepts, all or
 * none, since its answer says how many but never which. A partial
 * answer can't happen for sessions that pass its check, so one is read
 * as taking them all and any it dropped are reported unconfirmed.
 */
async function handedToLauncher(
	records: readonly SessionRecord[],
	saved: (sessionId: string) => boolean,
	handOver: (sessions: readonly HandedSession[]) => Promise<number | undefined>,
	placeOf: (record: SessionRecord) => HandedPlace,
): Promise<SessionRecord[]> {
	const going = records.filter(
		(record) =>
			saved(record.sessionId) &&
			launcherTakes({ id: record.sessionId, cwd: record.cwd }),
	);
	if (going.length === 0) return [];
	const taken = await handOver(
		going.map((record) => ({
			id: record.sessionId,
			cwd: record.cwd,
			...(record.quest ? { quest: record.quest } : {}),
			...(record.env ? { env: record.env } : {}),
			...placeOf(record),
			// Back where its own window was.
			replaces: record.sessionId,
		})),
	);
	return taken === undefined ? [] : going;
}

/**
 * Wait until each session is running again, or the wait runs out, and
 * return the ones that are. A resumed pi puts its own record back in
 * the open set as it starts; a fresh one started in a lost one's place
 * opens a record of its own on that quest, in that folder.
 */
async function awaitCheckIn(
	records: readonly SessionRecord[],
	saved: (sessionId: string) => boolean,
	waitMs: number,
): Promise<Set<string>> {
	const back = new Set<string>();
	const deadline = Date.now() + waitMs;
	while (back.size < records.length) {
		const fresh = records.some(
			(record) => !back.has(record.sessionId) && !saved(record.sessionId),
		);
		const all = fresh ? loadRecords().map((entry) => entry.record) : [];
		for (const record of records) {
			const id = record.sessionId;
			if (back.has(id)) continue;
			if (saved(id)) {
				const now = readRecord(id);
				if (now && now.closedAt === undefined) back.add(id);
			} else if (startedAgain(record, all, { running: true })) back.add(id);
		}
		if (back.size === records.length || Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, REOPEN_POLL_MS));
	}
	return back;
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
