/**
 * Messages waiting to start a turn of their own once the mesh settles.
 *
 * What an idle peer should act on, but need not drop everything for,
 * waits a little before it starts a turn: long enough that what arrives
 * beside it goes in the same turn, and that a question sent to a whole
 * group can be answered by one peer before the rest start on it. The
 * wait differs from peer to peer, spread by the session, so peers that
 * hear one message do not all start at once; the swarm quest settled
 * on varied thresholds for the same reason.
 *
 * Anything that starts a run first (the person, or a turn) takes what
 * is waiting with it, and the turn is never started.
 */

/** How long an act waits, at least, and how much longer at most. */
export interface Settling {
	readonly settleMs: number;
	readonly spreadMs: number;
}

/** A minute or less: half a minute, and up to half a minute more. */
export const SETTLING: Settling = { settleMs: 30_000, spreadMs: 30_000 };

export interface Acts<T> {
	/** Wait to act on this; the wait starts with the first waiting. */
	add(item: T): void;
	/** Everything waiting, which then no longer is, and no turn comes. */
	take(): T[];
	/** Stop waiting on whatever matches, without acting on it. */
	drop(matches: (item: T) => boolean): void;
	/** Stop the wait for good, as a session ending does. */
	stop(): void;
}

/**
 * A queue that calls `act` with everything waiting once it has waited
 * `settleMs` plus this session's share of `spreadMs`.
 */
export function createActs<T>(
	session: string,
	settling: Settling,
	act: (items: T[]) => void,
): Acts<T> {
	let waiting: T[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const wait = settling.settleMs + spreadOf(session, settling.spreadMs);
	const cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const take = () => {
		cancel();
		const taken = waiting;
		waiting = [];
		return taken;
	};
	return {
		add(item) {
			waiting = [...waiting, item];
			if (timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				const taken = take();
				if (taken.length > 0) act(taken);
			}, wait);
			// A wait never keeps a pi running that is otherwise done.
			timer.unref?.();
		},
		take,
		drop(matches) {
			waiting = waiting.filter((item) => !matches(item));
			if (waiting.length === 0) cancel();
		},
		stop() {
			take();
		},
	};
}

/** This session's share of the spread: the same every time it asks. */
export function spreadOf(session: string, spreadMs: number): number {
	if (spreadMs <= 0) return 0;
	let hash = 0;
	for (const char of session) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return hash % (spreadMs + 1);
}
