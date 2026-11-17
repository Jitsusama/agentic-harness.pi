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
 *
 * A session that parks takes its inbox only as it starts again, so a
 * Stop pressed on a row still showing it under way was read on the next
 * wake and ended the run a key the person typed had begun (KP0L6A, 17
 * November). So a Stop written before the run in progress began is
 * dropped, as is a Pause written before the person last talked to it,
 * since a talk ends a pause; each is said in the window and in a host's
 * journal. A Pause left for a parked session with no talk since still
 * holds when it wakes. Writer and reader keep their own clocks, so a
 * steer within {@link CLOCKS_DIFFER_MS} of either moment still acts, as
 * does one with no time that can be read. A session made in the middle
 * of a run, as a reload makes one, knows no start for that run, so a
 * Stop then acts whatever its time.
 */

import type { SteerAct } from "../../lib/mesh/steer.ts";

/** What pausing needs from its session. */
export interface PausingHost {
	/** The time now, in ms since the epoch, as Date.now gives it. */
	readonly now: () => number;
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
	/** Say it in the host's journal too, where the session has one. */
	readonly journal: (text: string) => void;
	/** End the session, as /exit does, saying `by` asked. */
	readonly close: (by: string) => void;
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
	/**
	 * The person did this from outside the window, in a steer `from`
	 * wrote, as the steer names its writer, at the ISO time `at` it says.
	 */
	act(act: Exclude<SteerAct, "carry">, from?: string, at?: string): void;
	/**
	 * The person carried it to the machine `to` from outside the window,
	 * in a steer `from` wrote: settles once it has carried and closed, or
	 * said why it couldn't.
	 */
	carry(to: string, from?: string): Promise<void>;
	/**
	 * The person talked to it, from the launcher or by typing in its
	 * window, at the ISO time `at` a steer says or now: a pause ends, and
	 * what they said is the turn.
	 */
	talked(at?: string): void;
	/** A run started: a paused session ends it at once. */
	started(): void;
	/** A turn ended, its tools done: a pause asked for mid-run lands. */
	turnEnded(): void;
}

/** Where a steer came from, as its writer signed it, for a host's journal. */
function steeredBy(from: string | undefined): string {
	return `from outside its window, steered by ${from === undefined || from === "" ? "a writer that didn't sign it" : from}`;
}

/**
 * How far apart a steer's writer's clock and this session's may be
 * before a steer written just after a moment reads as just before it:
 * the launcher writes on this machine, and the node brings steers from
 * machines it keeps in time.
 */
export const CLOCKS_DIFFER_MS = 2_000;

/** When a steer says it was written, in ms, or NaN when it doesn't say. */
function writtenAt(at: string | undefined): number {
	return at === undefined ? Number.NaN : Date.parse(at);
}

/** Pausing, as its peer last left it. */
export function createPausing(host: PausingHost): Pausing {
	let carrying = false;
	// When the run in progress began, unknown until one begins here.
	let runBegan = Number.NEGATIVE_INFINITY;
	// When the person last talked to it, as their talk says.
	let talkedAt = Number.NEGATIVE_INFINITY;
	// A steer written before `moment`, beyond what clocks differ by.
	const before = (at: string | undefined, moment: number): boolean =>
		writtenAt(at) < moment - CLOCKS_DIFFER_MS;
	const dropped = (
		what: string,
		from: string | undefined,
		at: string | undefined,
		why: string,
	) => {
		const line = `${what} ${steeredBy(from)}, written at ${at ?? "no time"}, was dropped: it came before ${why}.`;
		host.tell(line);
		host.journal(line);
	};
	return {
		get paused() {
			return host.paused();
		},
		act(act, from, at) {
			if (act === "stop" && !host.idle() && before(at, runBegan)) {
				dropped("A Stop", from, at, "the run in progress began");
				return;
			}
			if (act === "pause" && before(at, talkedAt)) {
				dropped("A Pause", from, at, "the person last talked to this session");
				return;
			}
			if (act === "close") {
				if (!host.idle()) host.abort();
				host.tell("Closed from outside this window.");
				host.close(`Close ${steeredBy(from)}`);
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
		talked(at) {
			const said = writtenAt(at);
			talkedAt = Math.max(talkedAt, Number.isNaN(said) ? host.now() : said);
			host.setPaused(false);
		},
		async carry(to, from) {
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
			host.close(`a carry to ${to} ${steeredBy(from)}`);
		},
		started() {
			runBegan = host.now();
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
