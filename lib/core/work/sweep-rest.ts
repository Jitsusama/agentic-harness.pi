/**
 * The rest the machine takes between sweeps, told by a stamp beside the
 * sweep's lock that says when the last one ended.
 */

import { statSync, utimesSync, writeFileSync } from "node:fs";

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
