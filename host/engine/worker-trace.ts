/**
 * Spike (worker per awake engine), never merged: a line-a-step trace of
 * the threads' talk, written only when PI_HOST_WORKERS_TRACE names a file,
 * to find where a run waits for ever.
 */
import { appendFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

const file = process.env.PI_HOST_WORKERS_TRACE;

/** Whether tracing is on. */
export const tracing = file !== undefined && file !== "";

/** Note `words` in the trace, with the time and this thread. */
export function trace(...words: readonly unknown[]): void {
	if (!tracing || file === undefined) return;
	const said = words
		.map((one) => (typeof one === "string" ? one : brief(one)))
		.join(" ");
	try {
		appendFileSync(file, `${new Date().toISOString()} t${threadId} ${said}\n`);
	} catch {
		// A trace that can't be written must not end the run it watches.
	}
}

/** A value short enough for a trace line. */
export function brief(value: unknown): string {
	let said: string;
	try {
		said = JSON.stringify(value) ?? String(value);
	} catch {
		// A value that won't serialise is named by its kind alone.
		said = typeof value;
	}
	return said.length > 160 ? `${said.slice(0, 160)}...` : said;
}
