/**
 * Crash Record extension.
 *
 * What the system's log hears of a pi: how long it took to be ready, and
 * why it ended when an uncaught error ends it.
 *
 * Once its first session has started and its history is drawn, a pi
 * writes `pi: ready in N ms` to the system's log, timed from the
 * process's start, without waiting on the write. See
 * `lib/internal/session/ready.ts`.
 *
 * A pi that an uncaught error ends says why where somebody will look:
 * in its session's log, as a `crash` entry, and in the system's log
 * (the journal on Linux, the unified log on macOS), with the stack. pi's
 * own handler still prints to the terminal, adds to crashes.json and
 * exits as before; this only writes first. It arms only in plain pi: a
 * host runs many conversations in one process and installs whatever
 * that process listens for itself. See
 * `lib/internal/session/crash-record.ts`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/host.ts";
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

/** The session entry a crash is kept as. */
export const CRASH_ENTRY = "crash";

/**
 * Registers this session's crash writer while the session runs, and
 * says when the process was first ready.
 */
export default function crashRecord(pi: ExtensionAPI): void {
	if (hosted()) return;
	const journal = journalCommand("err");
	const ready = watchReady();
	let stop: (() => void) | undefined;
	pi.on("session_start", (event, ctx) => {
		if (ctx.hasUI) ready.started(event.reason);
		stop?.();
		const session = sessionOf(ctx);
		stop = recordCrashes(
			session,
			writerFor(pi, `session ${session} in ${ctx.cwd}`, journal),
		);
	});
	pi.on("resources_discover", (_event, ctx) => {
		if (!ready.discovered()) return;
		const session = sessionOf(ctx);
		// pi draws the session's history once every handler here has
		// answered, so the next turn of the loop comes after it.
		setImmediate(() =>
			sayInJournal(
				readyLine(performance.timeOrigin, Date.now(), session),
				journalCommand("info"),
			),
		);
	});
	pi.on("session_shutdown", () => {
		stop?.();
		stop = undefined;
	});
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

function sessionOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context the session already replaced: one writer for the
		// process still says the crash, under no session's name.
		return "unknown";
	}
}
