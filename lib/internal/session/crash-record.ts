/**
 * What a pi says as an uncaught throw or rejection ends it.
 *
 * pi's own handler prints the error to its terminal, adds it to
 * `~/.pi/agent/crashes.json` and exits. The terminal goes with the
 * window once the session is started again elsewhere, and nothing reads
 * that file, so on 11 November about 40 pis died with nothing in either
 * the session's log or the journal. Node calls an
 * `uncaughtExceptionMonitor` listener before any handler, for a
 * rejection nothing handled too, and it changes nothing about how the
 * process ends. Each session's writer runs from there, synchronously,
 * while the process can still write.
 *
 * Spawn's wrapper taught what a listener left across a reload costs: the
 * older load's code runs against the newer one's state. So the process
 * keeps one listener, and each load replaces it with its own, keeping
 * the writers every session in the process registered.
 */

import { processGlobal } from "../process-global.ts";

/** One uncaught error, as a dying pi records it. */
export interface Crash {
	/** When it was caught, as an ISO 8601 time. */
	at: string;
	/** `uncaughtException`, or `unhandledRejection` for a promise nothing handled. */
	origin: string;
	message: string;
	stack?: string;
}

/** Writes a crash somewhere; it must finish before it returns. */
export type CrashWriter = (crash: Crash) => void;

/** Node's listener, called with the error and where it came from. */
type Monitor = (error: unknown, origin: string) => void;

interface Slot {
	listener?: Monitor;
	writers: Map<string, CrashWriter>;
}

/** The process's slot; a load whose slot has another shape takes a new version. */
export const CRASH_SLOT = "pi:harness:crash-record:v1";

/** The process's slot, shared by every load. */
function slotOf(): Slot {
	return processGlobal<Slot>(CRASH_SLOT, () => ({ writers: new Map() }));
}

/** The error as a crash, whatever was thrown. */
export function crashOf(
	error: unknown,
	origin: string,
	at = new Date(),
): Crash {
	if (error instanceof Error) {
		return {
			at: at.toISOString(),
			origin,
			message: error.message,
			stack: error.stack,
		};
	}
	return { at: at.toISOString(), origin, message: String(error) };
}

/**
 * Has `write` told of any uncaught error in this process, under `key`
 * (a session's id): a later call with the same key replaces it. The
 * process's listener is replaced with this load's own. The answer stops
 * it, and removes the listener once no writer is left.
 */
export function recordCrashes(key: string, write: CrashWriter): () => void {
	const slot = slotOf();
	slot.writers.set(key, write);
	if (slot.listener) process.off("uncaughtExceptionMonitor", slot.listener);
	const listener: Monitor = (error, origin) => {
		const crash = crashOf(error, origin);
		for (const writer of [...slot.writers.values()]) {
			try {
				writer(crash);
			} catch {
				// A writer that can't write mustn't keep the others from it,
				// nor change how the process ends: pi's handler still runs.
			}
		}
	};
	slot.listener = listener;
	process.on("uncaughtExceptionMonitor", listener);
	return () => {
		if (slot.writers.get(key) !== write) return;
		slot.writers.delete(key);
		if (slot.writers.size > 0 || !slot.listener) return;
		process.off("uncaughtExceptionMonitor", slot.listener);
		slot.listener = undefined;
	};
}

/** The crash as one block of text, naming whose it was. */
export function crashText(crash: Crash, who: string): string {
	const head = `pi ${who} is ending on an uncaught error (${crash.origin}) at ${crash.at}: ${crash.message}`;
	return crash.stack ? `${head}\n${crash.stack}` : head;
}
