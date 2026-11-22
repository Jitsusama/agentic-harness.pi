/**
 * Parking a session a stop reaches: the turn it is on finishes, nothing
 * new starts, and once Joel resumes the stop a session whose run the stop
 * ended carries on, told to look at what changed before it writes. One
 * the stop found idle stays idle, as it was.
 *
 * This is the session parking itself rather than a steer's pause, since
 * a pause ends when the person talks to the session and a stop must not:
 * only Joel resumes a stop. What Joel types himself still runs, though,
 * because a safe word that stopped him working would break the very
 * thing it protects. His run goes, and the write guard still holds every
 * write the stop reaches.
 *
 * A stop still in shadow parks nobody; which sessions it would have
 * parked is written beside the would-refuse log for Joel to read. A live
 * stop's parks are written too, once a session, so the launcher's row
 * for the stop can say how many sessions wait on Joel's resume.
 */

import { automatedText } from "../../lib/internal/automated.ts";
import {
	type Parked,
	parking,
	type Session,
} from "../../lib/internal/pineapple/park.ts";
import {
	describeReach,
	type Stop,
} from "../../lib/internal/pineapple/stops.ts";

/** What parking needs of its session and the world. */
export interface ParkingDeps {
	/** The stops standing now. */
	readonly stops: () => readonly Stop[];
	/** What the session is part of, given the stops that ask. */
	readonly session: (stops: readonly Stop[]) => Promise<Session>;
	/** Whether the session is between runs. */
	readonly idle: () => boolean;
	/** End the run under way, as stopped from outside rather than Escape. */
	readonly abort: () => void;
	/** Start a run with these words. */
	readonly carryOn: (text: string) => void;
	/** Say something on the session's screen. */
	readonly notify: (text: string) => void;
	/** Note a shadow stop that would have parked this session. */
	readonly wouldPark: (parked: Parked) => void;
	/** Note a live stop that parked this session. */
	readonly parked: (parked: Parked) => void;
}

/** A session's parking, driven by its events. */
export interface Parking {
	/** Words reached the session: the next run is Joel's when they are his. */
	heard(byPerson: boolean): void;
	/** A run started: end it when a stop parks the session. */
	started(): Promise<void>;
	/** A turn ended: end the run when a stop landed while it went. */
	turnEnded(): Promise<void>;
	/**
	 * The clock: park an idle session a stop reaches, and once the stops
	 * parking it are gone, carry on a run the stop ended.
	 */
	tick(): Promise<void>;
	/** Whether the session is parked now. */
	readonly parked: boolean;
}

/** What a session reads when the stop that parked it is resumed. */
export const RESUMED_TEXT = automatedText(
	"Joel resumed the safe-word stop that parked this session",
	"Carry on where you left off, but before any push, pull-request write or merge where the stop stood, check what changed there while it did: others may have moved on.",
);

/**
 * How many times where an idle session is may be answered from what was
 * last found: at the clock's ten seconds, a minute.
 */
const KNOWN_FOR = 6;

/** Make the parking for one session. */
export function createParking(deps: ParkingDeps): Parking {
	let personNext = false;
	let personRun = false;
	let parked = false;
	/** Whether the stop ended a run, which the resume then carries on. */
	let cut = false;
	const shadowTold = new Set<string>();
	const liveTold = new Set<string>();
	/**
	 * Where the session was found, for the stops that asked, kept between
	 * runs: nothing moves an idle session, and the clock asks every ten
	 * seconds, which would rerun its git lookups each time. It is asked
	 * again after KNOWN_FOR answers all the same, since a lookup a busy
	 * host timed out drops a repository, and a stop counted late beats
	 * one missed.
	 */
	let known:
		| { readonly stops: string; readonly session: Session; used: number }
		| undefined;

	async function whereabouts(stops: readonly Stop[]): Promise<Session> {
		const key = stops.map((stop) => stop.id).join(" ");
		if (known?.stops === key && known.used < KNOWN_FOR) {
			known.used += 1;
			return known.session;
		}
		const session = await deps.session(stops);
		known = { stops: key, session, used: 1 };
		return session;
	}

	async function parkers(): Promise<Parked[]> {
		const stops = deps.stops();
		if (stops.length === 0) return [];
		const found = parking(stops, await whereabouts(stops));
		for (const one of found.filter((each) => each.stop.shadow)) {
			// Once a session: the log says which sessions, not how often.
			if (shadowTold.has(one.stop.id)) continue;
			shadowTold.add(one.stop.id);
			deps.wouldPark(one);
		}
		return found.filter((one) => !one.stop.shadow);
	}

	/** Park the session, ending the run under way when `running`. */
	async function park(running = true): Promise<void> {
		const live = await parkers();
		if (live.length === 0) return;
		const first = !parked;
		parked = true;
		if (running) {
			cut = true;
			deps.abort();
		}
		note(live);
		if (first) deps.notify(parkedText(live));
	}

	/**
	 * Note each stop parking the session, once a session, as in shadow:
	 * the launcher and `stop all` count the sessions each stop parked, so
	 * one already parked by an earlier stop is noted for a later one too.
	 */
	function note(live: readonly Parked[]): void {
		for (const one of live) {
			if (liveTold.has(one.stop.id)) continue;
			liveTold.add(one.stop.id);
			deps.parked(one);
		}
	}

	return {
		heard(byPerson) {
			if (byPerson) personNext = true;
		},
		async started() {
			// A run may move the session, so where it is is asked afresh.
			known = undefined;
			personRun = personNext;
			personNext = false;
			if (personRun) return;
			await park();
		},
		async turnEnded() {
			known = undefined;
			if (personRun) return;
			await park();
		},
		async tick() {
			if (!deps.idle()) return;
			// An idle session a stop reaches is parked as it stands, so the
			// stop's count of parked sessions holds it without a run; one the
			// stop never cut is left idle by the resume, as it was found.
			if (!parked) return park(false);
			const live = await parkers();
			if (live.length > 0) return note(live);
			parked = false;
			if (!cut) return;
			cut = false;
			deps.carryOn(RESUMED_TEXT);
		},
		get parked() {
			return parked;
		},
	};
}

function parkedText(live: readonly Parked[]): string {
	const stops = live
		.map(
			(one) =>
				`${describeReach(one.reach)} (${one.because}${one.stop.saidBy ? `, said by ${one.stop.saidBy}` : ""})`,
		)
		.join("; ");
	return `Parked by Joel's safe word: ${stops}. Nothing starts here on its own until Joel resumes it; what you type still runs, and its writes there are still held.`;
}
