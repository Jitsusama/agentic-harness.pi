/**
 * Pause, Resume, Stop, Park, Close and Carry: what the person does to a
 * session from outside its window besides talk, through a steer's `act`.
 *
 * - Stop ends the run in progress at once; the session stays open and
 *   listening.
 * - Pause lets the run finish the turn it is on, tools and all, then
 *   ends it; until Resume, a talk or the person typing in the window,
 *   any other run that starts is ended as it starts, whatever started
 *   it, and the mesh hands its messages over without a turn.
 * - Resume clears the pause and has the session carry on; a talk or
 *   typing in the window does the same, its words being the turn.
 * - Park ends its process now if it is idle, or else once the turn it is
 *   on ends, as Pause waits, so it holds no memory; it stays held, and a
 *   message, a key or a window wakes it, as a park after an idle hour
 *   does (park-workflow). It is refused, saying why, where anything else
 *   holds it, where parking is off, or where neither a holder nor a host
 *   keeps it to wake it, since parking that one would only end it;
 *   mid-run, that is asked before the turn is ended, so a refused Park
 *   leaves the run going. A talk, Resume, Stop, Pause, Close or Carry
 *   before it lands calls it off.
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
 *   open, saying why, so nothing is lost. A Carry pressed while one is
 *   already under way, the person's or one the node ordered, is left to
 *   that one, which closes the session once it has carried: it neither
 *   ends a run nor stops the first from ending them, so a second press
 *   never lets a run start mid-carry.
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
 * since a talk ends a pause, and a Park written before the person last
 * talked to it or before it last started here: a Park doesn't wake a
 * session already parked, so one left for it is read as a message wakes
 * it, and would park it again at once. Each is said in the window and
 * in a host's journal. A Pause left for a parked session with no talk since still
 * holds when it wakes. Writer and reader keep their own clocks, so a
 * steer within {@link CLOCKS_DIFFER_MS} of either moment still acts, as
 * does one with no time that can be read. A session made in the middle
 * of a run, as a reload makes one, knows no start for that run, so a
 * Stop then acts whatever its time.
 */

import type { SteerAct } from "../../lib/mesh/steer.ts";
import {
	type CarriedClose,
	closeCarried,
	stoppedRun,
} from "./carried-close.ts";

/**
 * Why a Park is refused where no park watch answers: one starts only for
 * a person's session that a holder or a host keeps (park-workflow), and
 * parking any other would only end it.
 */
export const NOTHING_WAKES =
	"nothing here would wake it: neither a holder nor a host that parks one conversation alone keeps it, so parking it would only end it";

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
	/**
	 * End the session, as /exit does, saying `by` asked; where `failed`
	 * is given, a close that fails throws or is told to it once it has,
	 * as a host's close does after this returns, and one that lands is
	 * told to `closed`.
	 */
	readonly close: (
		by: string,
		failed?: (error: unknown) => void,
		closed?: () => void,
	) => void;
	/** How long a carried close may take before it counts as failed (carried-close.ts). */
	readonly closeMs?: number;
	/**
	 * Carry its work for the machine `to`, once its run has wound down,
	 * settling once its done file is written.
	 */
	readonly carry: (to: string) => Promise<void>;
	/** The machine a carry under way takes its work to, if one is. */
	readonly carryUnderWay: () => string | undefined;
	/**
	 * Park it now, idle time aside, as its park watch does once nothing
	 * holds it; answers why not.
	 */
	readonly park: () => string | undefined;
	/**
	 * What would refuse a park once its run settles, parking nothing, so a
	 * Park asked mid-run stops the run only where it will park.
	 */
	readonly parkable: () => string | undefined;
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
	/** A turn ended, its tools done: a pause or park asked for mid-run lands. */
	turnEnded(): void;
	/** Its run settled, pi idle: a park asked for mid-run parks it. */
	settled(): void;
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
	// When this session started here, before which a Park is stale.
	const began = host.now();
	// A Park asked for mid-run, by whom, to land once its run settles.
	let parking: { from: string | undefined } | undefined;
	// The close asked once carried, which says where this session's work
	// went though it couldn't close here, as each run it then stops says.
	let closing: CarriedClose | undefined;
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
		const line = `${what} ${steeredBy(from)}, written at ${at ?? "no time"}, was dropped: ${why}.`;
		host.tell(line);
		host.journal(line);
	};
	const refused = (from: string | undefined, why: string) => {
		const line = `A Park ${steeredBy(from)}, was refused: ${why}.`;
		host.tell(line);
		host.journal(line);
	};
	const park = (from: string | undefined) => {
		const why = host.park();
		if (why === undefined) {
			sayAnyway(() => host.journal(`Parked ${steeredBy(from)}.`));
			return;
		}
		refused(from, why);
	};
	// A Park waiting on its run, called off by what the person did since.
	const callOffPark = (by: string) => {
		if (parking === undefined) return;
		parking = undefined;
		host.tell(`The Park from outside this window is called off: ${by}.`);
	};
	return {
		get paused() {
			return host.paused();
		},
		act(act, from, at) {
			if (act === "stop" && !host.idle() && before(at, runBegan)) {
				dropped("A Stop", from, at, "it came before the run in progress began");
				return;
			}
			if (act === "pause" && before(at, talkedAt)) {
				dropped(
					"A Pause",
					from,
					at,
					"it came before the person last talked to this session",
				);
				return;
			}
			// A Park wakes nothing, so one left for a parked session is read
			// as it wakes: one that can't say when it was written may be that.
			if (act === "park" && Number.isNaN(writtenAt(at))) {
				dropped(
					"A Park",
					from,
					at,
					"it can't say when it was written, so it may be one left for this session before it woke",
				);
				return;
			}
			if (act === "park" && before(at, talkedAt)) {
				dropped(
					"A Park",
					from,
					at,
					"it came before the person last talked to this session",
				);
				return;
			}
			if (act === "park" && before(at, began)) {
				dropped("A Park", from, at, "it came before this session last started");
				return;
			}
			if (act === "park") {
				if (host.idle()) {
					park(from);
					return;
				}
				// Asked first, so a Park that would be refused never stops the
				// person's run for nothing.
				const why = host.parkable();
				if (why !== undefined) {
					refused(from, why);
					return;
				}
				parking = { from };
				host.tell("Parking from outside this window after the current turn.");
				return;
			}
			// Any other act is the person's latest word on it.
			callOffPark(`a ${act[0]?.toUpperCase()}${act.slice(1)} came after it`);
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
			callOffPark("the person talked to this session");
		},
		async carry(to, from) {
			// One under way may yet be refused, an ordered one by what it
			// finds, so this one is said as left, not promised a close, and
			// kept in the journal for a window nobody watches.
			const other = host.carryUnderWay();
			if (other !== undefined) {
				const line = `A Carry to ${to} ${steeredBy(from)}, was left to the carry to ${other} already under way, which closes this session if it carries; if that one is refused, Carry again.`;
				host.tell(line);
				host.journal(line);
				return;
			}
			callOffPark("a Carry came after it");
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
			closing = closeCarried({
				to,
				close: (failed, closed) =>
					host.close(`a carry to ${to} ${steeredBy(from)}`, failed, closed),
				// Kept in the journal too, for a window nobody watches.
				unclosed: (why) => {
					const line = `Carried to ${to}, but it couldn't close here: ${why}. Each run here is stopped, so the two never both work.`;
					sayAnyway(() => host.tell(line));
					sayAnyway(() => host.journal(line));
				},
				closedLate: () => {
					const line = `Carried to ${to}, and it closed here after all.`;
					sayAnyway(() => host.tell(line));
					sayAnyway(() => host.journal(line));
				},
				...(host.closeMs === undefined ? {} : { closeMs: host.closeMs }),
			});
		},
		started() {
			runBegan = host.now();
			if (!host.paused() && !carrying) return;
			const goneTo = closing?.goneTo();
			if (goneTo !== undefined) sayAnyway(() => host.tell(stoppedRun(goneTo)));
			host.abort();
		},
		turnEnded() {
			if ((host.paused() || parking) && !host.idle()) host.abort();
		},
		settled() {
			if (parking === undefined) return;
			const { from } = parking;
			parking = undefined;
			park(from);
		},
	};
}

/** Runs `say`, which a stale screen or journal may throw from, regardless. */
function sayAnyway(say: () => void): void {
	try {
		say();
	} catch {
		// Nothing more can say it; the run is still stopped.
	}
}

/** What the session reads when its person resumes it. */
export const RESUMED_TEXT =
	"[Resumed by the person from outside this window, after they paused it: carry on where you left off.]";
