/**
 * A fifo whose writer turns up late, for tests that a read never waits
 * on one. A read that waits gets the writer's words a second on, so the
 * test fails on them rather than hanging the run; a read that doesn't
 * wait is done long before, and the writer, left waiting for a reader,
 * is stopped.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";

/** How long the writer waits before it opens the fifo, in seconds. */
const LATE_S = 1;

/** A fifo made at `path`, written `words` a second on until stopped. */
export interface LateWriter {
	/** Stop the writer, whether or not anything read it. */
	stop(): void;
}

/**
 * Make a fifo at `path` and a writer that writes `words` into it once
 * {@link LATE_S} has passed.
 */
export function lateWriter(path: string, words: string): LateWriter {
	execFileSync("mkfifo", [path]);
	const writer: ChildProcess = spawn(
		"sh",
		["-c", `sleep ${LATE_S}; printf '%s' "$1" > "$2"`, "sh", words, path],
		{ stdio: "ignore" },
	);
	return {
		stop: () => {
			writer.kill("SIGKILL");
		},
	};
}
