/**
 * Pause, Resume and Stop: what the person does to a session from
 * outside its window besides talk, through a steer's `act`.
 *
 * - Stop ends the run in progress at once; the session stays open and
 *   listening.
 * - Pause lets the run finish the turn it is on, tools and all, then
 *   ends it; until Resume or a talk, any run that starts is ended as it
 *   starts, whatever started it, and the mesh hands its messages over
 *   without a turn.
 * - Resume clears the pause and has the session carry on; a talk does
 *   the same, its words being the turn.
 *
 * The pause itself is kept by the peer, in presence as `paused`, so it
 * outlasts a reload and the desktop shows it.
 */

import type { SteerAct } from "../../lib/mesh/steer.ts";

/** What pausing needs from its session. */
export interface PausingHost {
	/** Whether the session is between runs. */
	readonly idle: () => boolean;
	/** End the run in progress. */
	readonly abort: () => void;
	/** Whether it is paused, as its peer keeps it. */
	readonly paused: () => boolean;
	/** Keep it paused or not, in its peer. */
	readonly setPaused: (paused: boolean) => void;
	/** Have the session carry on where it left off. */
	readonly carryOn: () => void;
	/** Say on screen what the person did. */
	readonly tell: (text: string) => void;
}

/** Pausing for one session. */
export interface Pausing {
	/** Whether it is paused now. */
	readonly paused: boolean;
	/** The person did this from outside the window. */
	act(act: SteerAct): void;
	/** The person talked to it: a pause ends, and the talk is the turn. */
	talked(): void;
	/** A run started: a paused session ends it at once. */
	started(): void;
	/** A turn ended, its tools done: a pause asked for mid-run lands. */
	turnEnded(): void;
}

/** Pausing, as its peer last left it. */
export function createPausing(host: PausingHost): Pausing {
	return {
		get paused() {
			return host.paused();
		},
		act(act) {
			if (act === "stop") {
				host.setPaused(false);
				if (!host.idle()) host.abort();
				host.tell("Stopped from outside this window; listening.");
				return;
			}
			if (act === "pause") {
				host.setPaused(true);
				host.tell(
					host.idle()
						? "Paused from outside this window, until Resume or a talk."
						: "Pausing from outside this window after the current turn, until Resume or a talk.",
				);
				return;
			}
			if (!host.paused()) return;
			host.setPaused(false);
			host.tell("Resumed from outside this window.");
			host.carryOn();
		},
		talked() {
			host.setPaused(false);
		},
		started() {
			if (host.paused()) host.abort();
		},
		turnEnded() {
			if (host.paused() && !host.idle()) host.abort();
		},
	};
}

/** What the session reads when its person resumes it. */
export const RESUMED_TEXT =
	"[Resumed by the person from outside this window, after they paused it: carry on where you left off.]";
