/**
 * How long a pi took to be ready, said once in the system's log.
 *
 * Health reads each start from the journal to hold pi to its 3 second
 * spec, so the line keeps one wording, `pi: ready in N ms`, with the
 * session after it. Ready is when its extensions are bound, its
 * session started and its history drawn: the person can type before
 * then, but nothing they send is acted on.
 *
 * After the session come the parts an extension can see, so health can
 * tell a long log's start from a slow one:
 *
 * - `log B bytes`: the size of the session's log, which pi reads whole
 *   before it loads any extension;
 * - `loaded by L ms`: when crash-record loaded, part way through the
 *   extensions, so after the log was read;
 * - `bound by T ms`: when the session started, every extension bound.
 *
 * pi times its own phases, the log's read among them, only under
 * `PI_TIMING`, so the read itself can't be told apart from here.
 */

/** What the line says of one start, in milliseconds since the process began. */
export interface ReadyParts {
	readonly session: string;
	readonly readyMs: number;
	readonly logBytes?: number;
	readonly loadedMs?: number;
	readonly boundMs?: number;
}

/** The line a pi says once it is ready. */
export function readyLine(parts: ReadyParts): string {
	const said = [
		`pi: ready in ${whole(parts.readyMs)} ms`,
		`session ${parts.session}`,
	];
	if (parts.logBytes !== undefined) said.push(`log ${parts.logBytes} bytes`);
	if (parts.loadedMs !== undefined) {
		said.push(`loaded by ${whole(parts.loadedMs)} ms`);
	}
	if (parts.boundMs !== undefined) {
		said.push(`bound by ${whole(parts.boundMs)} ms`);
	}
	return said.join(", ");
}

/** Whole milliseconds, never less than nothing when a clock steps back. */
function whole(ms: number): number {
	return Math.max(0, Math.round(ms));
}

/** What the start the line times saw. */
export interface StartSeen {
	readonly boundMs: number;
}

/** What the session's starts say, so only the process's first is timed. */
export interface ReadyWatch {
	/** A session started, for `reason`, `atMs` after the process began. */
	started(reason: string, atMs: number): void;
	/** Its resources are found: what its start saw, if this was the first. */
	discovered(): StartSeen | undefined;
}

/**
 * Watches for the process's own start: a session started for
 * `startup`, then its resources found. A reload, a new session or a
 * resume starts again inside a process that was ready long before, so
 * none of them is timed.
 */
export function watchReady(): ReadyWatch {
	let starting: StartSeen | undefined;
	return {
		started(reason, atMs) {
			starting = reason === "startup" ? { boundMs: atMs } : undefined;
		},
		discovered() {
			const first = starting;
			starting = undefined;
			return first;
		},
	};
}
