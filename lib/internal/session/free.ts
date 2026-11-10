/**
 * Whether a session could end now without losing anything of its own.
 *
 * Ending a pi ends what runs in it: a run under way is cut short, and a
 * background job (a bash command handed off, a fleet, a review round)
 * dies with the process, as do messages queued for its next turn, a
 * prompt open for its person and words typed in its editor and not yet
 * sent. None of that is in its presence, so only the session itself can
 * say it is free. Parking asks this before it parks (park.ts), and a
 * move asks it before the session ends for a host to take it up
 * (move.ts).
 */

/** What a session holds that ending it now would lose. */
export interface Holding {
	/** Nothing runs, retries or waits to continue (pi's `isIdle`). */
	readonly agentIdle: boolean;
	/** Messages wait to be delivered to it. */
	readonly pendingMessages: boolean;
	/** Background jobs running, or finished and not yet said. */
	readonly jobs: number;
	/** A prompt is open for its person. */
	readonly prompting: boolean;
	/** Text typed in its editor and not yet sent. */
	readonly typed: boolean;
}

/** What holds this session, or nothing when it could end now. */
export function whatHolds(at: Holding): string | undefined {
	if (!at.agentIdle) return "a run is under way";
	if (at.pendingMessages) return "messages wait for it";
	if (at.jobs > 0) return "background jobs are out";
	if (at.prompting) return "a prompt is open";
	if (at.typed) return "text is typed and unsent";
	return undefined;
}
