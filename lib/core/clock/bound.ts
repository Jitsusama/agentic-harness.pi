/**
 * Bounding work that waits on something that may never answer.
 *
 * A browser, a language server and an HTTP API can each simply not
 * answer: a page that runs no script never finishes a wait that needs
 * one, a server busy on a large project sits on a request, and a
 * socket whose peer went quiet holds a call open. Their own bounds are
 * long or missing, which is a long time to hold a tool call a person
 * is waiting on, and none of them notices when the person has already
 * given up.
 *
 * So work is raced against two things it cannot outlast: the caller's
 * signal, which ends the wait the moment it fires and says so as an
 * abort, and a wall clock, which says what took too long. Whatever
 * was left running is handed to a give-up callback to tear down, and
 * its late answer is dropped rather than left to surface as an
 * unhandled rejection.
 */

/** How long a bounded piece of work may take, and who may stop it. */
export interface Bounds {
	/** The caller giving up. An abort ends the wait at once. */
	readonly signal?: AbortSignal;
	/** The longest the work may run before it is given up on. */
	readonly wallMs: number;
	/** What the work is, as a phrase: "reading https://...". */
	readonly what: string;
}

/**
 * The work outlasted its wall clock.
 *
 * Named TimeoutError, the name the platform gives a timed-out
 * AbortSignal, so a caller can tell it from an abort and from the
 * work's own failure without matching on the message.
 */
export class WallClockExceeded extends Error {
	override readonly name = "TimeoutError";

	constructor(what: string, wallMs: number) {
		super(
			`${what} took longer than ${formatSeconds(wallMs)}, so it was given up on`,
		);
	}
}

/**
 * The error that says a caller gave up, shaped the way fetch and
 * every other AbortSignal consumer shape one. A reason the caller
 * supplied is passed on when it is itself an abort.
 */
export function abortError(signal?: AbortSignal): Error {
	const reason: unknown = signal?.reason;
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	return new DOMException("The operation was aborted.", "AbortError");
}

/** Whether an error says its caller gave up. */
export function isAbort(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Settle with the work, or give up on it the moment its signal fires
 * or its wall clock runs out, whichever comes first.
 *
 * giveUp runs once, and only when the work is abandoned; it is where
 * a caller closes whatever the work was waiting on, so nothing is
 * left running for the rest of the process's life.
 */
export async function bounded<T>(
	work: Promise<T>,
	bounds: Bounds,
	giveUp?: () => void,
): Promise<T> {
	const { signal, wallMs, what } = bounds;
	const abandon = (): void => {
		// The work may still fail later, and its answer is nobody's
		// any more. The race below listens to it, but a signal that
		// had already fired means the race never starts, and then an
		// unhandled rejection would be reported as a fault in
		// whatever happened to be running at the time.
		work.catch(() => {});
		giveUp?.();
	};
	if (signal?.aborted) {
		abandon();
		throw abortError(signal);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stopped = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abandon();
			reject(new WallClockExceeded(what, wallMs));
		}, wallMs);
		onAbort = () => {
			abandon();
			reject(abortError(signal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, stopped]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/** A duration in whole seconds, or milliseconds below one. */
function formatSeconds(ms: number): string {
	return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}
