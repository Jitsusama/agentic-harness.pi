/**
 * A child host rolls its conversation onto new code once its install
 * moves on. A child never restarts itself, since its supervisor starts a
 * fresh one for each conversation, so it keeps the host code it loaded
 * for its life: on 22 November 15 children ran host code about 34 hours
 * old and held 10.9 GB. Its conversation's extensions follow the install
 * (reload-workflow), but the host and engine don't. So the child looks
 * now and then at its install, and once the host code there differs it
 * rolls: its conversation parks at its next quiet moment, the parked
 * child with no window exits as it always does, and the next wake starts
 * a fresh child on current code.
 */

/** How often a child looks at its install: often enough that a roll waits minutes, not hours. */
export const LOOK_EVERY_MS = 5 * 60_000;

/** How a roll looks again after a wait; a test passes its own timers. */
export type After = (ms: number, run: () => void) => () => void;

const realAfter: After = (ms, run) => {
	const timer = setTimeout(run, ms);
	timer.unref();
	return () => clearTimeout(timer);
};

/**
 * Look at `moved` each `lookMs` and, the first time it says why the
 * host's code is stale, roll with that reason and stop looking, since
 * stale code stays stale. A look that throws is reported and looks again.
 * Answers the function that stops looking.
 */
export function rollWhenStale(
	moved: () => Promise<string | undefined>,
	roll: (why: string) => void,
	options: {
		lookMs?: number;
		after?: After;
		report?: (message: unknown) => void;
	} = {},
): () => void {
	const lookMs = options.lookMs ?? LOOK_EVERY_MS;
	const after = options.after ?? realAfter;
	let stopped = false;
	let cancel = (): void => undefined;
	const look = async () => {
		let why: string | undefined;
		try {
			why = await moved();
		} catch (error) {
			options.report?.(error);
		}
		if (stopped) return;
		if (why === undefined) {
			cancel = after(lookMs, () => void look());
			return;
		}
		stopped = true;
		roll(why);
	};
	cancel = after(lookMs, () => void look());
	return () => {
		stopped = true;
		cancel();
	};
}
