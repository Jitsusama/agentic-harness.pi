/**
 * The moves waiting in this process, which hold an install's reload of
 * their session off (reload-workflow's follow.ts). A move waits for its
 * session to be free, then writes the note a host or plain pi takes it
 * up by and closes the session (mesh-workflow's moving.ts). A reload the
 * follower starts as the same run settles stops the move unwritten, and
 * the move restarts the session on current code anyway, so the reload
 * is the one that waits.
 *
 * On 23 November E30 (tests/host/end-to-end/release-reopen.test.ts)
 * failed three full host test runs under load, 87 to 93 s in, and passed
 * three of three alone in 57 to 65 s: a slow machine let the follower's
 * reload go between the run's settle and the move's next look.
 *
 * A waiting move renews its hold at every look, every couple of seconds,
 * and the hold lapses by itself {@link MOVE_HOLDS_MOST_MS} after the last
 * renewal, so a move whose looks stopped (a stuck runtime, a stop that
 * was never said) never keeps an install's reload off for long. A move
 * lets go when it is called off and when its runtime stops.
 *
 * A hold covers every move that waits, whatever holds it: a job or an
 * open prompt clears as a run does, with the same race, so an idle
 * session waiting on one runs its old code until the move is made or
 * called off at its bound, and the move restarts it on current code.
 * Only the install's follower honours a hold: a reload the person or
 * the agent asks for goes, and the move carries over it and looks again
 * as the session restarts.
 *
 * Held on `globalThis`, so a host's conversations, each with its own
 * modules, are held apart by their session's id.
 */

import { performance } from "node:perf_hooks";
import { processGlobal } from "../process/process-global.ts";

/**
 * How long a hold lasts past the move's last look. A move looks every
 * 2 s; a minute covers a starved event loop many times over. The
 * follower looks again every 30 s, so a reload goes at most a minute
 * and a half after a move stopped looking.
 */
export const MOVE_HOLDS_MOST_MS = 60_000;

/** How a hold is timed, given in tests. */
export interface MoveHoldTiming {
	/** A clock that never jumps: suspend and clock steps move no hold. */
	readonly now?: () => number;
	readonly mostMs?: number;
}

interface Held {
	readonly to: string;
	readonly until: number;
}

/** The version changes with the shape. */
const WAITING_KEY = "pi.session.move-waiting.v1";

const waiting = () => processGlobal(WAITING_KEY, () => new Map<string, Held>());

const monotonic = () => performance.now();

/**
 * Hold `session`'s install reload off for a move to `to`, from now until
 * {@link MOVE_HOLDS_MOST_MS} has passed or {@link letMoveGo} is called;
 * called again, it renews the hold.
 */
export function holdForMove(
	session: string,
	to: string,
	timing: MoveHoldTiming = {},
): void {
	const now = (timing.now ?? monotonic)();
	waiting().set(session, {
		to,
		until: now + (timing.mostMs ?? MOVE_HOLDS_MOST_MS),
	});
}

/** The move waiting for `session` is off, made or stopped: its hold goes. */
export function letMoveGo(session: string): void {
	waiting().delete(session);
}

/**
 * Where a move waiting for `session` goes, while its hold lasts, or
 * nothing when no move holds the session's reload off.
 */
export function moveWaiting(
	session: string,
	timing: Pick<MoveHoldTiming, "now"> = {},
): string | undefined {
	const held = waiting().get(session);
	if (held === undefined) return undefined;
	if ((timing.now ?? monotonic)() < held.until) return held.to;
	waiting().delete(session);
	return undefined;
}
