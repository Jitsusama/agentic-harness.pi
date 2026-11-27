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
 *
 * A child rolls no sooner than an hour after it started. Each roll ends
 * a conversation's process, and it reads as a cut to the cell in it: on
 * 26 November one install move at 15:06 rolled 42 conversations, and
 * cells counted several cuts that day as merges moved the install. Held
 * to an hour, a conversation rolls at most once an hour however often
 * the install moves.
 */

/** How often a child looks at its install: often enough that a roll waits minutes, not hours. */
export const LOOK_EVERY_MS = 5 * 60_000;

/** How long a child runs before it may roll: a conversation rolls at most once in this. */
export const ROLL_ONLY_AFTER_MS = 60 * 60_000;

const MINUTE_MS = 60_000;

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
 * stale code stays stale. A look that throws is reported, saying what
 * it was looking for, and looks again. Stale before `rollsFrom`, it says
 * so and looks again then, rolling with what the install says at that
 * look. Answers the function that stops looking, which holds even over
 * a look already under way.
 */
export function rollWhenStale(
	moved: () => Promise<string | undefined>,
	roll: (why: string) => void,
	options: {
		lookMs?: number;
		after?: After;
		report?: (message: unknown) => void;
		/** The moment, in epoch milliseconds, before which it never rolls. */
		rollsFrom?: number;
		now?: () => number;
	} = {},
): () => void {
	const lookMs = options.lookMs ?? LOOK_EVERY_MS;
	const after = options.after ?? realAfter;
	const now = options.now ?? Date.now;
	const rollsFrom = options.rollsFrom ?? 0;
	let toldTooSoon = false;
	let stopped = false;
	let cancel = (): void => undefined;
	const look = async () => {
		let why: string | undefined;
		try {
			why = await moved();
		} catch (error) {
			if (stopped) return;
			const said = error instanceof Error ? error.message : String(error);
			options.report?.(
				`Couldn't tell whether the install's host code moved on, so it looks again: ${said}`,
			);
		}
		if (stopped) return;
		if (why === undefined) {
			cancel = after(lookMs, () => void look());
			return;
		}
		const early = rollsFrom - now();
		if (early > 0) {
			if (!toldTooSoon)
				options.report?.(
					`${capitalised(why)}, but it may not roll yet, so it looks again in ${minutes(early)}`,
				);
			toldTooSoon = true;
			cancel = after(early, () => void look());
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

function capitalised(words: string): string {
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function minutes(ms: number): string {
	const count = Math.ceil(ms / MINUTE_MS);
	return count === 1 ? "a minute" : `${count} minutes`;
}

/** What a child's roll is wired to: its install, its host and its life. */
export interface ChildRoll {
	/** Why the install's host code differs from the child's, or nothing. */
	readonly moved: () => Promise<string | undefined>;
	/** The host holding the conversation, once its engine is being made. */
	readonly host: () => { roll(): void } | undefined;
	/** Settles, either way, as the child's host stops. */
	readonly stopped: Promise<unknown>;
	readonly report: (message: unknown) => void;
	readonly lookMs?: number;
	readonly after?: After;
	/** When the child started, in epoch milliseconds; the wiring's moment if left out. */
	readonly bornAt?: number;
	readonly now?: () => number;
}

/**
 * Roll a child's conversation once its install's host code moves on:
 * say why, and roll the host holding it then, though never within an
 * hour of the child's start. It looks until the child's host stops,
 * however that ends.
 */
export function rollChildWhenStale(wiring: ChildRoll): void {
	const now = wiring.now ?? Date.now;
	const bornAt = wiring.bornAt ?? now();
	const stop = rollWhenStale(
		wiring.moved,
		(why) => {
			wiring.report(
				`Rolling onto new code, as ${why}: the conversation parks at its next quiet moment unless a window views it`,
			);
			wiring.host()?.roll();
		},
		{
			report: wiring.report,
			rollsFrom: bornAt + ROLL_ONLY_AFTER_MS,
			now,
			...(wiring.lookMs === undefined ? {} : { lookMs: wiring.lookMs }),
			...(wiring.after ? { after: wiring.after } : {}),
		},
	);
	wiring.stopped.then(stop, stop);
}
