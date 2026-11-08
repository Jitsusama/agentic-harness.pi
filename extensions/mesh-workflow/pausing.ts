/**
 * Pause, Resume, Stop, Close and Carry: what the person does to a session
 * from outside its window besides talk, through a steer's `act`.
 *
 * - Stop ends the run in progress at once; the session stays open and
 *   listening.
 * - Pause lets the run finish the turn it is on, tools and all, then
 *   ends it; until Resume, a talk or the person typing in the window,
 *   any other run that starts is ended as it starts, whatever started
 *   it, and the mesh hands its messages over without a turn.
 * - Resume clears the pause and has the session carry on; a talk or
 *   typing in the window does the same, its words being the turn.
 * - Close ends the session for good, as /exit does: any run in progress
 *   is ended, then pi shuts down, so its record reads closed rather
 *   than lost and nothing offers it back unasked. Its quest, trees and
 *   what waits on the person stay as they are (the launcher's Close,
 *   VKCF3Z's ruling, 7 November).
 * - Carry takes the session's work to another machine, as the person
 *   does moving from one laptop to another: any run in progress is
 *   ended, every tree it holds and its own file are put in its quest's
 *   handover with a done file saying so (carrying.ts), and then it
 *   closes as Close does. A run that starts from then on is ended, so
 *   the file carried is the whole session. A carry that fails leaves it
 *   open, saying why, so nothing is lost.
 *
 * An ended run ends away mode (away-workflow), so a Stop, or a Pause
 * landing mid-run, ends it for every session: pressing either says the
 * person is at the desk.
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
	/** End the session, as /exit does. */
	readonly close: () => void;
	/**
	 * Carry its work for the machine `to`, once its run has wound down,
	 * settling once its done file is written.
	 */
	readonly carry: (to: string) => Promise<void>;
}

/** Pausing for one session. */
export interface Pausing {
	/** Whether it is paused now. */
	readonly paused: boolean;
	/** The person did this from outside the window. */
	act(act: Exclude<SteerAct, "carry">): void;
	/**
	 * The person carried it to the machine `to` from outside the window:
	 * settles once it has carried and closed, or said why it couldn't.
	 */
	carry(to: string): Promise<void>;
	/**
	 * The person talked to it, from the launcher or by typing in its
	 * window: a pause ends, and what they said is the turn.
	 */
	talked(): void;
	/** A run started: a paused session ends it at once. */
	started(): void;
	/** A turn ended, its tools done: a pause asked for mid-run lands. */
	turnEnded(): void;
}

/** Pausing, as its peer last left it. */
export function createPausing(host: PausingHost): Pausing {
	let carrying = false;
	return {
		get paused() {
			return host.paused();
		},
		act(act) {
			if (act === "close") {
				if (!host.idle()) host.abort();
				host.tell("Closed from outside this window.");
				host.close();
				return;
			}
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
		async carry(to) {
			carrying = true;
			if (!host.idle()) host.abort();
			host.tell(
				`Carrying this session's work to ${to}, from outside this window.`,
			);
			try {
				await host.carry(to);
			} catch (error) {
				carrying = false;
				host.tell(
					`This session's work couldn't be carried to ${to}, so it stays open: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			host.tell(`Carried to ${to}; closing.`);
			host.close();
		},
		started() {
			if (host.paused() || carrying) host.abort();
		},
		turnEnded() {
			if (host.paused() && !host.idle()) host.abort();
		},
	};
}

/** What the session reads when its person resumes it. */
export const RESUMED_TEXT =
	"[Resumed by the person from outside this window, after they paused it: carry on where you left off.]";
