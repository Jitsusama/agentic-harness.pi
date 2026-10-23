/**
 * What becomes of a write the guard caught: it is kept, whole, and the
 * person is told in one line whose it was, once a minute at most for
 * the same line from the same writer, so a handler that throws on
 * every tick cannot fill the screen the guard is there to keep clean.
 */

import type { StrayHandler } from "../../lib/internal/stray/guard.ts";
import { keepStray } from "../../lib/internal/stray/log.ts";
import { reportOf, type StrayReport } from "../../lib/internal/stray/report.ts";

/** How long the same line from the same writer goes unrepeated. */
export const NOTICE_QUIET_MS = 60_000;

/** What a handler is given. */
export interface StrayOptions {
	/** The log every caught write is kept in. */
	readonly log: string;
	/** How the log is named to the person, home folded to `~`. */
	readonly logName?: string;
	/** The session the writes belong to, when there is one. */
	readonly session?: string;
	/** How to tell the person; left out, writes are kept and nothing said. */
	readonly notify?: (text: string) => void;
	/** The clock, for tests. */
	readonly now?: () => number;
}

/** A handler that keeps each write and tells the person about it. */
export function strayHandler(options: StrayOptions): StrayHandler {
	const now = options.now ?? Date.now;
	const told = new Map<string, number>();
	return (write) => {
		const report = reportOf(write);
		keepStray(options.log, {
			at: new Date(now()).toISOString(),
			...(options.session ? { session: options.session } : {}),
			...write,
			...report,
		});
		if (!options.notify) return;
		const key = `${report.writer ?? ""}\n${report.line}`;
		const last = told.get(key);
		if (last !== undefined && now() - last < NOTICE_QUIET_MS) return;
		told.set(key, now());
		options.notify(noticeOf(report, options.logName ?? options.log));
	};
}

/** The line a person reads in place of the junk. */
export function noticeOf(report: StrayReport, log: string): string {
	const what = report.channel
		? `${report.writer ? `${report.writer}'s` : "A"} ${report.channel} handler threw`
		: `${report.writer ?? "Something"} wrote past the screen`;
	return `${what}: ${report.line}\nKept, with its stack, in ${log}.`;
}
