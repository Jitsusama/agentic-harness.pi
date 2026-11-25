/**
 * A script's commands stopped when the script itself is told to stop.
 *
 * `spawnExec` starts each command in a process group of its own, so
 * a terminal's Ctrl-C or a service manager's SIGTERM aimed at the
 * script never reaches them: the script ends and a `git clone` it
 * started carries on, writing into a folder nobody will take out.
 * The signal this returns fires on the first ending signal the script
 * gets, and `spawnExec` given it stops each command's group at once.
 *
 * Ending the script is not ours to take from whoever else listens. A
 * host listening for the same signal saves its state there, so with
 * another listener this only stops the commands; alone, it raises the
 * signal again once its own listener is gone, so the default, being
 * ended by it, still happens, with the status a shell reports.
 */

/** The signals a person or a machine ends a script with. */
export const ENDING = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** What this listens on and ends: the running process, or a test's stand-in. */
export interface Ended {
	readonly pid: number;
	once(signal: NodeJS.Signals, listener: () => void): unknown;
	off(signal: NodeJS.Signals, listener: () => void): unknown;
	listenerCount(signal: NodeJS.Signals): number;
	kill(pid: number, signal: NodeJS.Signals): unknown;
}

/**
 * A signal that fires on the first of `ENDING` the process gets, its
 * reason naming that signal. Every listener it set is taken off as it
 * fires, so a second Ctrl-C ends the process as it would have anyway.
 */
export function stoppedBySignals(ended: Ended = process): AbortSignal {
	const stop = new AbortController();
	const listeners = ENDING.map((signal) => {
		const listener = () => {
			for (const [other, off] of listeners) ended.off(other, off);
			stop.abort(new Error(`it was told to stop (${signal})`));
			if (ended.listenerCount(signal) === 0) ended.kill(ended.pid, signal);
		};
		ended.once(signal, listener);
		return [signal, listener] as const;
	});
	return stop.signal;
}
