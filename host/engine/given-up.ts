/**
 * Resting a conversation the host still holds whose child was given up
 * before it ran there (F167). A start's bounded resume gives a starved
 * child up at its listen or answer time, and a conversation that never
 * parked has no marker naming the host's wake file, so restsParked,
 * which rests only one that parked, declines it and nothing would watch
 * its wake: a message sent to it would wait for a window. This writes
 * the marker a park writes, naming this host's wake file, so a sender
 * finds where to wake it, and then takes it on as restsParked does.
 */
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import {
	clearParked,
	parkFolder,
	readParked,
	writeParked,
} from "../../lib/internal/session/park.ts";

/** Where a given-up conversation is rested, as the engine keeps it. */
export interface GivenUpPlace {
	/** Whether this host runs the conversation now. */
	runs(sessionId: string): boolean;
	/** The wake file this host watches for it. */
	wakeFile(sessionId: string): string;
	/** Take it on resting, as restsParked does once its marker stands. */
	takeOn(entry: RosterEntry): void;
	/** Where park markers are kept; park-workflow's by default. */
	folder?: string;
	/** The host process that rests it, named as the parker. */
	readonly pid: number;
}

/**
 * Rest `entry` as parked, answering nothing once it rests: refused,
 * answering why, while this host runs it or a marker from this boot
 * names another holder's wake. Else its marker is written naming this
 * host's wake file, unless it names that already (a marker from an
 * earlier boot is overwritten, as no holder of that boot still runs),
 * and it is taken on. A take-on that throws removes the marker it
 * wrote, so no sender is sent to a wake nothing watches.
 */
export function restGivenUp(
	entry: RosterEntry,
	place: GivenUpPlace,
): string | undefined {
	const { sessionId } = entry;
	if (place.runs(sessionId)) return "this host runs it now";
	const folder = place.folder ?? parkFolder();
	const wake = place.wakeFile(sessionId);
	const marker = readParked(sessionId, folder);
	if (marker !== undefined && marker.wake !== wake)
		return `its marker names another holder's wake, ${marker.wake}`;
	if (marker === undefined)
		writeParked(
			{
				session: sessionId,
				sessionFile: entry.file,
				cwd: entry.cwd,
				// Its addresses are its own pi's to say, which never ran here.
				addresses: [],
				...(entry.quest ? { quest: entry.quest } : {}),
				parkedAt: new Date().toISOString(),
				pid: place.pid,
				wake,
			},
			folder,
		);
	try {
		place.takeOn(entry);
	} catch (error) {
		if (marker === undefined) clearParked(sessionId, folder);
		throw error;
	}
	return undefined;
}
