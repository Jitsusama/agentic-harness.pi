/**
 * The claim on reading the machine for a keep of the queue, so one
 * session reads it while the others leave it.
 *
 * Every session asks to keep the queue every two seconds, and a keep
 * that finds the folder kept within the last two seconds gives way. But
 * the reading comes before the keep: it walks every process's name,
 * about 2,000 files, and takes some 200 ms, so every session whose tick
 * fell in that time read the machine and kept it again. On 12 November,
 * with jobs in the queue, as many as eight sessions kept it within half
 * a second, and a pi left idle spent 1.9% of a core, most of it reading
 * /proc for those keeps. Claiming the reading first leaves one reading
 * a keep.
 */

import { mkdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * How old a claim is before it is taken as left by a session that died
 * reading: far past a reading's time, as the queue's own lock is.
 */
export const READING_CLAIM_MS = 10_000;

/**
 * Claims the reading for a keep of the queue at `dir`, giving back the
 * function that hands it back, or nothing while another session holds it.
 */
export function claimReading(
	dir: string,
	now: number,
): (() => void) | undefined {
	const locks = join(dir, "locks");
	const claim = join(locks, "reading");
	try {
		mkdirSync(locks, { recursive: true });
		mkdirSync(claim);
	} catch {
		if (!leftBehind(claim, now)) return undefined;
		try {
			rmdirSync(claim);
			mkdirSync(claim);
		} catch {
			// Another session took it over first: it reads.
			return undefined;
		}
	}
	return () => rmSync(claim, { recursive: true, force: true });
}

/** Whether a claim is old enough to be a dead session's. */
function leftBehind(claim: string, now: number): boolean {
	try {
		return now - statSync(claim).mtimeMs >= READING_CLAIM_MS;
	} catch {
		// Gone as it was looked at: the next keep claims it.
		return false;
	}
}
