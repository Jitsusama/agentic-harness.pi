/**
 * Work left for a replaced session never ends the process.
 *
 * A reload, a rollover or a session switch replaces the extension
 * context, and every read of the old one then throws pi's "stale"
 * error. Work still on its way for the replaced session (an answer
 * from a command, a provider's reply) that reads it rejects, and when
 * nothing watches that promise Node raises it as an uncaught
 * exception, which pi records in crashes.json and exits on. On 7
 * November one footer item ended sessions that way dozens of times,
 * each at a reload.
 *
 * Each such case is still fixed where it happens; this is the net
 * under them. One handler per process drops a rejection that is pi's
 * stale error, since the session it was for is gone, and writes it to
 * a log with its stack, so it is found and fixed rather than hidden.
 * Any other rejection is thrown again from the handler, which Node
 * raises as an uncaught exception, as it did before the handler, so
 * pi crashes on it as it always has.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { processGlobal } from "../process-global.ts";

/** How pi's error for a replaced context begins. */
const STALE = "This extension ctx is stale after session replacement or reload";

/** How many lines of a stack the log keeps: enough to name the file. */
const STACK_LINES = 12;

/** Whether `reason` is pi's error for reading a replaced context. */
export function isStaleContext(reason: unknown): reason is Error {
	return reason instanceof Error && reason.message.startsWith(STALE);
}

/** One dropped rejection, as the log keeps it. */
export interface DroppedRejection {
	readonly at: string;
	readonly stack: string;
}

/**
 * Handle one unhandled rejection: tell `drop` of a stale context's and
 * return, or throw anything else again, as Node would have.
 */
export function handleRejection(
	reason: unknown,
	drop: (dropped: DroppedRejection) => void,
): void {
	if (!isStaleContext(reason)) throw reason;
	const stack = reason.stack ?? reason.message;
	drop({
		at: new Date().toISOString(),
		stack: stack.split("\n").slice(0, STACK_LINES).join("\n"),
	});
}

/** The one handler a process has, and the log the latest load names. */
interface Net {
	log?: string;
}

/**
 * Drop stale-context rejections for the rest of the process, writing
 * each to `log` as a JSON line. Every load calls this; the handler is
 * added once, and the log is the latest load's.
 */
export function spareStaleRejections(log: string): void {
	const net = processGlobal<Net>("pi:harness:stale-rejections:v1", () => {
		const made: Net = {};
		process.on("unhandledRejection", (reason) =>
			handleRejection(reason, (dropped) => write(made.log, dropped)),
		);
		return made;
	});
	net.log = log;
}

function write(log: string | undefined, dropped: DroppedRejection): void {
	if (log === undefined) return;
	try {
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, `${JSON.stringify(dropped)}\n`);
	} catch {
		// A log that can't be written loses one line; the process lives.
	}
}
