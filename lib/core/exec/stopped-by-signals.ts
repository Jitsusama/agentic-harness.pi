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
 * The script is not ended in the same tick. Each command it awaits
 * then ends aborted, so its own flow refuses and cleans up as it does
 * for any failed command, and `spawnExec` still kills a command that
 * outlives its SIGTERM. Only a script still going once that is past
 * is ended by the signal, raised again, so a flow stuck on something
 * no signal stops can't keep it.
 *
 * Ending the script is not ours to take from whoever else listens. A
 * host listening for the same signal saves its state there, so with
 * another listener this only stops the commands.
 *
 * Meant for a script's one run: its listeners are taken off only by
 * the first signal, and the signal it returns is never taken back.
 */

import { KILL_GRACE_MS } from "./spawn.ts";

/** The signals a person or a machine ends a script with. */
export const ENDING = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * How long a stopped script has to end on its own before the signal
 * ends it: past `spawnExec`'s own wait before it kills a command, so
 * that kill comes first, with time for the script's cleanup after.
 */
export const WIND_DOWN_MS = KILL_GRACE_MS + 3000;

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
export function stoppedBySignals(
	ended: Ended = process,
	windDownMs = WIND_DOWN_MS,
): AbortSignal {
	const stop = new AbortController();
	const listeners = ENDING.map((signal) => {
		const listener = () => {
			for (const [other, off] of listeners) ended.off(other, off);
			stop.abort(new Error(`it was told to stop (${signal})`));
			if (ended.listenerCount(signal) > 0) return;
			// Unheld, so a script whose flow has ended isn't kept for it.
			setTimeout(() => ended.kill(ended.pid, signal), windDownMs).unref();
		};
		ended.once(signal, listener);
		return [signal, listener] as const;
	});
	return stop.signal;
}
