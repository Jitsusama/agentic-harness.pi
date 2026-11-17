/**
 * The signal stamp: how a session's record learns that a terminal or
 * the machine took it away, rather than a deliberate quit.
 *
 * Plain pi listens for SIGHUP and SIGTERM itself; a host says how each
 * of its conversations ended on the bus. Either way the record is
 * stamped synchronously, before the process can exit.
 */

import {
	hosted,
	isSessionStamp,
	SESSION_STAMP_EVENT,
} from "../../../lib/core/session/host.ts";
import { sessionSlot } from "../../../lib/core/session/slot.ts";
import { markSignalled } from "../../../lib/internal/quest/sessions/session-registry.ts";
import { isParking, PARKING } from "../../../lib/internal/session/park.ts";
import { readRecord, recordSessionEnd, saveRecord } from "./records.ts";

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
 * signal ends it. pi's own shutdown ends an idle pi in about 200 ms;
 * at the 13 November reboot the two held pis that finished took 0.9
 * and 1.9 s, and 60 more were still going when the account's manager
 * ran out of its 5 s stop and was killed whole. Two seconds leaves
 * the rest of that 5 s to the holders and terminals around each pi.
 */
const ENDING_GRACE_MS = 2_000;

/** What ending a process by a signal needs of it: `process`, in life. */
interface SignalTarget {
	readonly pid: number;
	readonly removeAllListeners: (signal: NodeJS.Signals) => void;
	readonly kill: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * End the process by a signal's own default action. pi keeps its
 * listener while it shuts down, and a second signal only finds that
 * shutdown already under way, so sending it again with pi listening
 * would change nothing. Every listener goes first. What pi writes as
 * it goes (the session's log, the record stamped above) is written
 * synchronously, so nothing it has said is lost.
 */
export function endBySignal(
	signal: NodeJS.Signals,
	target: SignalTarget = process,
): void {
	target.removeAllListeners(signal);
	target.kill(target.pid, signal);
}

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
	raise: (signal) => endBySignal(signal),
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
 * stamp the listeners remove themselves, and after a grace period the
 * signal ends the process by its default action. If pi has already
 * exited, nothing happens. If its shutdown is still going, the process
 * dies of the signal as it would with no listener at all, so a
 * shutdown that stalls can't hold up the account's stop.
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
			deps.schedule(() => deps.raise(signal), ENDING_GRACE_MS);
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
