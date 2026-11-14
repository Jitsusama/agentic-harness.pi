/**
 * Parking a session a stop reaches: the turn it is on finishes, nothing
 * new starts, and once Joel resumes the stop it carries on, told to look
 * at what changed before it writes.
 *
 * This is the session parking itself rather than a steer's pause, since
 * a pause ends when the person talks to the session and a stop must not:
 * only Joel resumes a stop. What Joel types himself still runs, though,
 * because a safe word that stopped him working would break the very
 * thing it protects. His run goes, and the write guard still holds every
 * write the stop reaches.
 *
 * A stop still in shadow parks nobody; which sessions it would have
 * parked is written beside the would-refuse log for Joel to read.
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
}

/** A session's parking, driven by its events. */
export interface Parking {
	/** Words reached the session: the next run is Joel's when they are his. */
	heard(byPerson: boolean): void;
	/** A run started: end it when a stop parks the session. */
	started(): Promise<void>;
	/** A turn ended: end the run when a stop landed while it went. */
	turnEnded(): Promise<void>;
	/** The clock: carry on once the stops parking the session are gone. */
	tick(): Promise<void>;
	/** Whether the session is parked now. */
	readonly parked: boolean;
}

/** What a session reads when the stop that parked it is resumed. */
export const RESUMED_TEXT = automatedText(
	"Joel resumed the safe-word stop that parked this session",
	"Carry on where you left off, but before any push, pull-request write or merge where the stop stood, check what changed there while it did: others may have moved on.",
);

/** Make the parking for one session. */
export function createParking(deps: ParkingDeps): Parking {
	let personNext = false;
	let personRun = false;
	let parked = false;
	const shadowTold = new Set<string>();

	async function parkers(): Promise<Parked[]> {
		const stops = deps.stops();
		if (stops.length === 0) return [];
		const found = parking(stops, await deps.session(stops));
		for (const one of found.filter((each) => each.stop.shadow)) {
			// Once a session: the log says which sessions, not how often.
			if (shadowTold.has(one.stop.id)) continue;
			shadowTold.add(one.stop.id);
			deps.wouldPark(one);
		}
		return found.filter((one) => !one.stop.shadow);
	}

	async function park(): Promise<void> {
		const live = await parkers();
		if (live.length === 0) return;
		const first = !parked;
		parked = true;
		deps.abort();
		if (first) deps.notify(parkedText(live));
	}

	return {
		heard(byPerson) {
			if (byPerson) personNext = true;
		},
		async started() {
			personRun = personNext;
			personNext = false;
			if (personRun) return;
			await park();
		},
		async turnEnded() {
			if (personRun) return;
			await park();
		},
		async tick() {
			if (!parked || !deps.idle()) return;
			if ((await parkers()).length > 0) return;
			parked = false;
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
