/**
 * The hold that keeps plain pi off a conversation's log: a host that has
 * it open, or one that keeps it on its roster and takes it up again as
 * it starts.
 *
 * On 11 November K7 found plain pi would open a conversation a crashed
 * host still kept: the host's list died with it, but its roster stayed,
 * and the host resumes every conversation on its roster when systemd
 * starts it again, a second writer on the same log. So a roster holds a
 * conversation too (host-holds.ts). One case is not a hold: a running
 * host that has just let a conversation go drops it from its list first
 * and from its roster a moment after, so a pi started on a move to pi in
 * between waits that moment out rather than being refused. A conversation
 * the running host parked while idle is kept the same way, but its park
 * marker tells it from one being let go, so it is said at once.
 */

import {
	type HoldsLooking,
	type HostHold,
	hostHold,
	rosterHolds,
} from "./host-holds.ts";
import { hostRunning } from "./one-writer.ts";
import { isParked } from "./park.ts";

/** How long a running host is given to drop from its roster what it let go. */
export const ROSTER_SETTLE_MS = 2000;

/** How often the roster is read again while it settles. */
const SETTLE_POLL_MS = 100;

/** Where to look, and how long a drop may take; the machine's unless a test sets them. */
export interface WriterLooking extends HoldsLooking {
	readonly settleMs?: number;
	/** park-workflow's folder, whose markers say which conversations are parked. */
	readonly parks?: string;
}

/**
 * The host whose hold keeps plain pi off this conversation's log, or
 * nothing when plain pi may write it.
 */
export async function writerHold(
	sessionId: string,
	looking: WriterLooking = {},
): Promise<HostHold | undefined> {
	const hold = await hostHold(sessionId, looking);
	if (!hold || hold.open) return hold;
	// Kept by a host that is down: it takes the conversation up as it starts.
	if (!(await hostRunning(hold.key, looking))) return hold;
	// Parked while idle: park-workflow writes the marker before it asks the
	// host and clears it as the woken conversation starts, and the engine
	// clears it as a restart resumes one.
	if (isParked(sessionId, looking.parks)) return { ...hold, parked: true };
	const until = Date.now() + (looking.settleMs ?? ROSTER_SETTLE_MS);
	while (Date.now() < until) {
		if (rosterHolds(looking.rosters).get(sessionId) !== hold.key)
			return undefined;
		// A drop the host makes after its list's; nothing announces it, so its roster is read again.
		await new Promise((settle) => setTimeout(settle, SETTLE_POLL_MS));
	}
	// Still kept by a running host that couldn't resume it: its next start tries again.
	return rosterHolds(looking.rosters).get(sessionId) === hold.key
		? hold
		: undefined;
}
