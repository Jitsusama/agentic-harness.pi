/**
 * How long a pi took to be ready, said once in the system's log.
 *
 * Health reads each start from the journal to hold pi to its 3 second
 * spec, so the line keeps one wording, `pi: ready in N ms`, with the
 * session after it. Ready is when its extensions are bound, its
 * session started and its history drawn: the person can type before
 * then, but nothing they send is acted on.
 */

/** The line a pi says once it is ready, `readyAt - startedAt` after it started. */
export function readyLine(
	startedAt: number,
	readyAt: number,
	session: string,
): string {
	const ms = Math.max(0, Math.round(readyAt - startedAt));
	return `pi: ready in ${ms} ms, session ${session}`;
}

/** What the session's starts say, so only the process's first is timed. */
export interface ReadyWatch {
	/** A session started, for `reason`. */
	started(reason: string): void;
	/** Its resources are found: the line to say now, if this was the first. */
	discovered(): boolean;
}

/**
 * Watches for the process's own start: a session started for
 * `startup`, then its resources found. A reload, a new session or a
 * resume starts again inside a process that was ready long before, so
 * none of them is timed.
 */
export function watchReady(): ReadyWatch {
	let starting = false;
	return {
		started(reason) {
			starting = reason === "startup";
		},
		discovered() {
			const first = starting;
			starting = false;
			return first;
		},
	};
}
