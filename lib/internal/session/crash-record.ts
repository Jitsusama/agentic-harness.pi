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

import { spawnSync } from "node:child_process";
import { systemFolders, systemProgram } from "../system-program.ts";

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

const SLOT = Symbol.for("agentic-harness.session.crash-record");

/** The longest a journal write may hold a dying process up. */
const JOURNAL_WAIT_MS = 2_000;

/** Whether `found` is a slot of this shape. */
function isSlot(found: unknown): found is Slot {
	return (
		typeof found === "object" &&
		found !== null &&
		"writers" in found &&
		found.writers instanceof Map
	);
}

/** The process's slot, made afresh when one an older load left has another shape. */
function slotOf(): Slot {
	const found: unknown = Reflect.get(process, SLOT);
	if (isSlot(found)) return found;
	const made: Slot = { writers: new Map() };
	Reflect.set(process, SLOT, made);
	return made;
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

/** What writes to the system's log, and the arguments it takes. */
export interface JournalCommand {
	program: string;
	args: string[];
}

/**
 * How to write to the system's log: systemd-cat into the journal on
 * Linux, logger into the unified log on macOS, each found only where
 * the system put it; nothing when neither is there.
 */
export function journalCommand(
	find: (program: string, folders: readonly string[]) => string | undefined = (
		program,
		folders,
	) => systemProgram(program, folders),
): JournalCommand | undefined {
	const cat = find("systemd-cat", systemFolders());
	if (cat) return { program: cat, args: ["-t", "pi", "-p", "err"] };
	const logger = find("logger", ["/usr/bin", ...systemFolders()]);
	if (logger) return { program: logger, args: ["-t", "pi", "-p", "user.err"] };
	return undefined;
}

/** Writes `text` to the system's log and waits for it, briefly. */
export function writeJournal(
	text: string,
	command: JournalCommand | undefined,
): void {
	if (!command) return;
	spawnSync(command.program, command.args, {
		input: text,
		stdio: ["pipe", "ignore", "ignore"],
		timeout: JOURNAL_WAIT_MS,
	});
}
