/**
 * The rest the machine takes between sweeps, told by a stamp beside the
 * sweep's lock that says when the last one ended, and the stamp a sweep
 * outside every pi host leaves for the hosts' own sweeps to stand down by.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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
 * ran to its end within {@link OUTSIDE_SWEEP_HOLDS_MS} of `now`, judging
 * the trees of every provider in `judged`, which are the ones this host
 * would judge. A host runs every conversation on one thread, and its
 * sweeps' git calls and folder listings held that thread for up to 262 s
 * on 19 November, freezing every conversation in it; a sweep in a
 * process of its own holds none. A host with a provider the sweep outside
 * didn't load sweeps as before, or that provider's trees would stay for
 * good.
 */
export function sweptOutsideSince(
	lockPath: string,
	now: number,
	judged: readonly string[],
): string | undefined {
	const read = readStamp(outsideStamp(lockPath));
	if (read === undefined) return undefined;
	const { stamped, judgedThere } = read;
	if (!Array.isArray(judgedThere)) return undefined;
	if (judged.some((provider) => !judgedThere.includes(provider))) {
		return undefined;
	}
	const ago = now - stamped;
	// A stamp from the future, as a clock set back leaves, holds nobody.
	return ago >= 0 && ago < OUTSIDE_SWEEP_HOLDS_MS
		? `a sweep outside the hosts ran ${Math.round(ago / 1000)} s ago`
		: undefined;
}

/** The most a stamp holds: a list of a few providers' names. */
const STAMP_MOST_BYTES = 4096;

/**
 * When the stamp at `stamp` was dated and what it says was judged, or
 * nothing when there is no plain file there to read. A host reads it on
 * its one thread, so it follows no link and waits on no pipe.
 */
function readStamp(
	stamp: string,
): { stamped: number; judgedThere: unknown } | undefined {
	let fd: number;
	try {
		fd = openSync(
			stamp,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch {
		// No stamp, or a link where it goes: no sweep outside to stand for.
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > STAMP_MOST_BYTES) return undefined;
		const bytes = Buffer.alloc(stat.size);
		const got = readSync(fd, bytes, 0, stat.size, 0);
		const said = JSON.parse(bytes.subarray(0, got).toString("utf8")) as {
			judged?: unknown;
		};
		return { stamped: stat.mtimeMs, judgedThere: said.judged };
	} catch {
		// A stamp that won't read or parse stands for no sweep outside.
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * Stamp that a sweep outside every host has run to its end, judging the
 * trees of every provider in `judged`, for {@link sweptOutsideSince},
 * dated `at` by the sweep's own clock, and say why when it couldn't. It
 * is written beside and renamed into place, so a link planted where it
 * goes is replaced rather than followed.
 */
export function markSweptOutside(
	lockPath: string,
	at: number,
	judged: readonly string[],
): string | undefined {
	const stamp = outsideStamp(lockPath);
	const written = `${stamp}.${randomBytes(4).toString("hex")}`;
	try {
		// A machine whose first sweep this is has no work state folder yet.
		mkdirSync(dirname(stamp), { recursive: true });
		writeFileSync(written, JSON.stringify({ judged }), { flag: "wx" });
		utimesSync(written, at / 1000, at / 1000);
		renameSync(written, stamp);
		return undefined;
	} catch (error) {
		// Unwritten, the hosts go on sweeping as before, one at a time.
		rmSync(written, { force: true });
		return error instanceof Error ? error.message : String(error);
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
