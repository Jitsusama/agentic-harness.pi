/**
 * When a finished run rings: only for the person who asked for it, and
 * only once they have had time to look away.
 *
 * Dozens of sessions run on the machine at once, most of them working on
 * a mesh message, a steer from outside the window, a job's report or a
 * resume after a compaction. None of those is a person waiting, so a run
 * rings only when the person typed into it, in this window. Everything
 * else pi delivers arrives from another extension or over RPC, and the
 * harness's own turns carry the automated header even when they come
 * through the editor.
 */

import { isAutomatedText } from "../../lib/internal/automated.ts";

/**
 * How long after the person last typed a run must end before it rings.
 *
 * About ten seconds is how long a person keeps their attention on a
 * screen that is working for them before they turn to something else
 * (Nielsen's response-time limits [1]). Twice that leaves quiet the
 * quick answers they are still watching for, which a ding would only
 * interrupt, and still rings for most of the work they hand over: in
 * the fortnight of session logs before this was written, about 12% of
 * the 3,114 typed runs ended within 20 seconds and 88% went longer.
 *
 * [1]: https://www.nngroup.com/articles/response-times-3-important-limits/
 */
export const LOOKED_AWAY_MS = 20_000;

/**
 * Something that joined or started a run: a message through pi's input,
 * typed or sent, or a custom message that woke an idle session.
 */
export type Arrival =
	| {
			kind: "input";
			source: "interactive" | "rpc" | "extension";
			text: string;
			/** Undefined when the session was idle, so this starts a run. */
			streamingBehavior?: "steer" | "followUp";
	  }
	| { kind: "message" };

/** A run that has settled, as the ring rule reads it. */
export interface Settled {
	/** Whether anybody can be at the session: false in print and JSON mode. */
	attended: boolean;
	/** When the person last typed into the run, if they did. */
	heardAt?: number;
	/** When it settled. */
	at: number;
	/** Whether it was stopped, which Escape does with the person right there. */
	aborted: boolean;
	/** Whether the person said they are away from the machine. */
	away: boolean;
}

/**
 * When the person was last heard from in the run `arrival` joins or
 * starts, given when they were heard from before it, or undefined when
 * the run is not theirs.
 *
 * A message the person types is theirs whenever it comes. Anything else
 * that starts a run starts one that isn't theirs, and anything else that
 * joins a run under way leaves it whoever's it was.
 */
export function heardAt(
	before: number | undefined,
	arrival: Arrival,
	at: number,
): number | undefined {
	if (arrival.kind === "message") return undefined;
	if (arrival.source === "interactive" && !isAutomatedText(arrival.text)) {
		return at;
	}
	return arrival.streamingBehavior === undefined ? undefined : before;
}

/**
 * Whether a settled run rings: the person typed into it in a session
 * somebody can be at, and it ran on long enough after that for them to
 * have looked away, without being stopped and while they are at the
 * machine.
 */
export function rings(run: Settled): boolean {
	if (!run.attended || run.aborted || run.away) return false;
	if (run.heardAt === undefined) return false;
	return run.at - run.heardAt >= LOOKED_AWAY_MS;
}

/**
 * The system log's line for a ring heard in `session`, so the dings a
 * day can be counted (2RCBOJ, 12 November), with how long the person
 * had waited, to the second.
 */
export function dingLine(session: string, run: Settled): string {
	const waited = Math.round((run.at - (run.heardAt ?? run.at)) / 1000);
	return `pi: done ding, session ${session}, ${waited} s after the person typed`;
}
