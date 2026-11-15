/**
 * Crash Record extension.
 *
 * What the system's log hears of a pi: how long it took to be ready,
 * why it ended when an uncaught error ends it, and what held it when it
 * is slow to end.
 *
 * Once its first session has started and its history is drawn, a pi
 * writes `pi: ready in N ms` to the system's log, timed from the
 * process's start, with its log's size and how far the start had got
 * when this loaded and when the session started, without waiting on
 * the write. See `lib/internal/session/ready.ts`.
 *
 * A pi that an uncaught error ends says why where somebody will look:
 * in its session's log, as a `crash` entry, and in the system's log
 * (the journal on Linux, the unified log on macOS), with the stack. pi's
 * own handler still prints to the terminal, adds to crashes.json and
 * exits as before; this only writes first. It arms only in plain pi: a
 * host runs many conversations in one process and installs whatever
 * that process listens for itself. See
 * `lib/internal/session/crash-record.ts`.
 *
 * A pi still ending 2 seconds after a TERM or a HUP, or after its
 * session quit, says what held it: `pi: still ending` in the system's
 * log, naming what the process still holds open and the processes
 * under it, with a fuller record in its state folder's `slow-ends/`.
 * The watch never keeps the process up; the log line waits on nothing,
 * and writing the record blocks the loop a few ms, once.
 * See `lib/internal/session/slow-end.ts`.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/host.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	type CrashWriter,
	crashText,
	recordCrashes,
} from "../../lib/internal/session/crash-record.ts";
import {
	type JournalCommand,
	journalCommand,
	sayInJournal,
	writeJournal,
} from "../../lib/internal/session/journal.ts";
import { readyLine, watchReady } from "../../lib/internal/session/ready.ts";
import {
	childrenOf,
	slowEndLine,
	watchSlowEnd,
	writeSlowEnd,
} from "../../lib/internal/session/slow-end.ts";

/** How long a pi may take to end before it says what holds it. */
export const SLOW_END_MS = 2_000;

/** The session entry a crash is kept as. */
export const CRASH_ENTRY = "crash";

/**
 * Registers this session's crash writer while the session runs, and
 * says when the process was first ready.
 */
export default function crashRecord(pi: ExtensionAPI): void {
	if (hosted()) return;
	const loadedMs = performance.now();
	const journal = journalCommand("err");
	const ready = watchReady();
	let stop: (() => void) | undefined;
	let slowEnd: ReturnType<typeof watchSlowEnd> | undefined;
	pi.on("session_start", (event, ctx) => {
		if (ctx.hasUI) ready.started(event.reason, performance.now());
		stop?.();
		const session = sessionOf(ctx);
		slowEnd?.stop();
		slowEnd = watchSlowEnd({
			afterMs: SLOW_END_MS,
			signals: process,
			raise: (signal) => process.kill(process.pid, signal),
			onSlow: (cause, afterMs) => saySlowEnd(session, cause, afterMs),
		});
		stop = recordCrashes(
			session,
			writerFor(pi, `session ${session} in ${ctx.cwd}`, journal),
		);
	});
	pi.on("resources_discover", (_event, ctx) => {
		const seen = ready.discovered();
		if (!seen) return;
		const session = sessionOf(ctx);
		const log = logOf(ctx);
		// pi draws the session's history once every handler here has
		// answered, so the next turn of the loop comes after it.
		setImmediate(() => {
			const readyMs = performance.now();
			sayInJournal(
				readyLine({
					session,
					readyMs,
					logBytes: log ? sizeOf(log) : undefined,
					loadedMs,
					boundMs: seen.boundMs,
				}),
				journalCommand("info"),
			);
		});
	});
	pi.on("session_shutdown", (event) => {
		stop?.();
		stop = undefined;
		// Only a quit ends the process; a reload, new session, resume or
		// fork starts the next session in it, which watches afresh.
		if (event.reason === "quit") slowEnd?.arm("quit");
		else slowEnd?.stop();
	});
}

/**
 * Says what holds a pi still ending: a record in the state folder, and
 * a line in the system's log, which waits on nothing.
 */
function saySlowEnd(session: string, cause: string, afterMs: number): void {
	const pid = process.pid;
	const end = {
		pid,
		session,
		cause,
		afterMs,
		active: process.getActiveResourcesInfo(),
		children: childrenOf(pid),
	};
	const file = writeSlowEnd(
		end,
		join(stateDir("crash-record-workflow"), "slow-ends"),
	);
	sayInJournal(slowEndLine(end, file), journalCommand("err"));
}

/** Writes a crash to the session's log, then to the system's. */
function writerFor(
	pi: ExtensionAPI,
	who: string,
	journal: JournalCommand | undefined,
): CrashWriter {
	return (crash) => {
		try {
			pi.appendEntry(CRASH_ENTRY, crash);
		} catch {
			// A session that can't take the entry any more still has the
			// journal say it, the one place left that outlives it.
		}
		writeJournal(crashText(crash, who), journal);
	};
}

/** The session's log, if it has one on disk. */
function logOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile();
	} catch {
		// A context the session already replaced: the line goes without
		// the log's size rather than not at all.
		return undefined;
	}
}

/** How large `file` is, if it can still be read. */
function sizeOf(file: string): number | undefined {
	try {
		return statSync(file).size;
	} catch {
		// A log not written yet, or moved: the line leaves the size out.
		return undefined;
	}
}

function sessionOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context the session already replaced: one writer for the
		// process still says the crash, under no session's name.
		return "unknown";
	}
}
