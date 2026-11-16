/**
 * Whether the warm browser's child process and pipes hold the event
 * loop.
 *
 * Kept apart from the shared browser because ref and unref are a
 * small contract with Node's handles, testable on a stand-in, while
 * deciding when to hold is the shared browser's business.
 */

/**
 * Stop the warm browser from being the only reason this process
 * stays alive.
 *
 * The browser is kept between sessions so the next call does not
 * pay a second and a half to launch Chrome again. But its child
 * process, its stdio pipes and its DevTools socket all hold the
 * event loop, so a script that opened a session, did its work
 * and closed it sat there until the five-minute idle close fired
 * and only then exited. Measured: two and a half seconds of
 * work, three hundred and one seconds of wall clock, three and a
 * half seconds of CPU. Anything wiring this into CI would have
 * read that as a hang.
 *
 * unref does not close anything. The browser stays usable and
 * the idle close still runs; it just stops counting as a reason
 * to keep running. A session has its own handles and is
 * unaffected, and a script exits when its own work is done.
 */
export function releaseEventLoop(child: LoopHandle | null): void {
	if (!child) return;
	child.unref();
	for (const pipe of child.stdio) nudge(pipe, "unref");
}

/**
 * The part of a child process this cares about.
 *
 * stdio is left loose because a pipe's declared stream type does
 * not carry ref and unref even though a socket-backed one has
 * them, so each entry is asked rather than assumed.
 */
export interface LoopHandle {
	ref(): void;
	unref(): void;
	readonly stdio: readonly unknown[];
}

/** Ask a stdio entry to ref or unref itself, if it can. */
function nudge(pipe: unknown, how: "ref" | "unref"): void {
	if (typeof pipe !== "object" || pipe === null) return;
	const method = (pipe as Record<string, unknown>)[how];
	if (typeof method === "function") method.call(pipe);
}

/**
 * Keep the process alive for as long as a teardown needs.
 *
 * The inverse of releaseEventLoop. Closing a browser is several
 * round trips, and once nothing is ref'd Node is free to exit
 * in the middle of them, which leaves the caller's promise
 * hanging and Chrome to be reaped as an orphan next run.
 */
export function holdEventLoop(child: LoopHandle | null): void {
	if (!child) return;
	child.ref();
	for (const pipe of child.stdio) nudge(pipe, "ref");
}
