/**
 * The rest the machine takes between sweeps, told by a stamp beside the
 * sweep's lock that says when the last one ended.
 */

import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The stamp beside a sweep's lock that says when the last sweep ended. */
function endedStamp(lockPath: string): string {
	return `${lockPath}.ended`;
}

/**
 * Why a sweep should rest, when one ended within `restMs` of `now`.
 * Every conversation sweeps on its own timer, and one sweep reads every
 * tree: on 18 November about 120 of them kept one machine sweeping
 * without a break, each sweep 3 to 12 minutes long and every one taking
 * nothing, while the rest found the lock held about every 3 seconds.
 */
export function restingSince(
	lockPath: string,
	now: number,
	restMs: number | undefined,
): string | undefined {
	if (restMs === undefined) return undefined;
	let ended: number;
	try {
		ended = statSync(endedStamp(lockPath)).mtimeMs;
	} catch {
		// No stamp, or none to read: rest from nothing, as a stamp that
		// couldn't be written does. The lock still keeps sweeps apart.
		return undefined;
	}
	const ago = now - ended;
	// A stamp from the future, as a clock set back leaves, rests nobody.
	return ago >= 0 && ago < restMs
		? `a sweep ended ${Math.round(ago / 1000)} s ago`
		: undefined;
}

/**
 * How long a sweep run outside any pi host keeps the hosts' own sweeps
 * standing down: two of its hourly runs, so one missed run changes
 * nothing, while a timer that stops for good hands sweeping back to the
 * hosts within two hours.
 */
export const OUTSIDE_SWEEP_HOLDS_MS = 2 * 60 * 60 * 1000;

/** The stamp beside a sweep's lock that says a sweep ran outside the hosts. */
function outsideStamp(lockPath: string): string {
	return `${lockPath}.outside`;
}

/**
 * Why a host's own sweep should stand down: a sweep outside every host
 * started or ended within {@link OUTSIDE_SWEEP_HOLDS_MS} of `now`. A host runs
 * every conversation on one thread, and its sweeps' git calls and folder
 * listings held that thread for up to 262 s on 19 November, freezing
 * every conversation in it; a sweep in a process of its own holds none.
 */
export function sweptOutsideSince(
	lockPath: string,
	now: number,
): string | undefined {
	let stamped: number;
	try {
		stamped = statSync(outsideStamp(lockPath)).mtimeMs;
	} catch {
		// No stamp, or none to read: no sweep outside, so the hosts sweep.
		return undefined;
	}
	const ago = now - stamped;
	// A stamp from the future, as a clock set back leaves, holds nobody.
	return ago >= 0 && ago < OUTSIDE_SWEEP_HOLDS_MS
		? `a sweep outside the hosts ran ${Math.round(ago / 1000)} s ago`
		: undefined;
}

/**
 * Stamp that a sweep outside every host is starting or has ended, for
 * {@link sweptOutsideSince}, dated `at` by the sweep's own clock.
 */
export function markSweptOutside(lockPath: string, at: number): void {
	const stamp = outsideStamp(lockPath);
	try {
		// A machine whose first sweep this is has no work state folder yet.
		mkdirSync(dirname(stamp), { recursive: true });
		writeFileSync(stamp, "");
		utimesSync(stamp, at / 1000, at / 1000);
	} catch {
		// Unwritten, the hosts go on sweeping as before, one at a time.
	}
}

/**
 * Stamp that a sweep has just ended, for {@link restingSince}, dated by
 * the sweep's own clock rather than the file system's, so the two
 * readings of the rest are of one clock. Only its time is read, so it
 * holds nothing.
 */
export function markEnded(lockPath: string, at: number): void {
	const stamp = endedStamp(lockPath);
	try {
		writeFileSync(stamp, "");
		utimesSync(stamp, at / 1000, at / 1000);
	} catch {
		// A stamp that can't be written only lets the next sweep come
		// sooner, which the lock still keeps from overlapping this one.
	}
}
