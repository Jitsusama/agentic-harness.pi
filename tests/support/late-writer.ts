/**
 * A fifo whose writer turns up late, for tests that a read never waits
 * on one.
 *
 * A read that waits, at its open or its read, is held until the writer
 * comes, so it takes at least {@link LATE_MS}; a test proves a read
 * never waited by its taking under half that, which no waiting read
 * can. The writer then writes again for every reader that comes, so a
 * read that waits, however often, gets words and ends rather than
 * hanging the run. It is stopped once the test is done.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";

/** How long the writer waits before it first opens the fifo. */
export const LATE_MS = 2000;

/** A fifo made at `path`, written `words` from {@link LATE_MS} on. */
export interface LateWriter {
	/** Stop the writer, whether or not anything read it. */
	stop(): void;
}

/**
 * Make a fifo at `path` and a writer that, once {@link LATE_MS} has
 * passed, writes `words` into it for each reader that opens it.
 */
export function lateWriter(path: string, words: string): LateWriter {
	execFileSync("mkfifo", [path]);
	const writer: ChildProcess = spawn(
		"sh",
		[
			"-c",
			`sleep ${LATE_MS / 1000}; while :; do printf '%s' "$1" > "$2"; done`,
			"sh",
			words,
			path,
		],
		{ stdio: "ignore" },
	);
	return {
		stop: () => {
			writer.kill("SIGKILL");
		},
	};
}

/** What `read` gives, and how long it took to, in milliseconds. */
export function timed<T>(read: () => T): { value: T; tookMs: number } {
	const started = performance.now();
	const value = read();
	return { value, tookMs: performance.now() - started };
}
