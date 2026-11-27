/**
 * When this machine booted, which bounds what is still under way: a
 * process, a holder or a marker from before it belongs to a boot that
 * is over. The mesh's liveness, the restore record and park markers
 * all judge by it, so it lives below each of them.
 */

import { readFileSync } from "node:fs";

/** When the machine booted, in milliseconds since the epoch, if it says. */
export type Booted = () => number | undefined;

/**
 * When the machine booted, in milliseconds since the epoch, read from
 * the kernel's `btime`; nothing where the machine will not say. Nothing
 * a peer started before then is under way any more.
 *
 * The kernel's own answer is read once a process: a boot doesn't move
 * while a process runs, and a park check asks for each parked peer of
 * each message heard. So a start that took in a backlog read the whole
 * of `/proc/stat` that often: 0.9 s on the thread of one background
 * host's start on 26 Nov 2026. A given `read` is read each time.
 * The kernel's `btime` moves as the wall clock is stepped, which is
 * why a kept one is read again then (bootReadOnce); a process's start,
 * judged to the tick, reads it fresh (`process-ticks.ts`).
 */
export function machineBooted(read?: () => string): number | undefined {
	return read === undefined ? kernelBooted() : bootedFrom(read)?.at;
}

/**
 * How far the wall clock may move against the monotonic one before a
 * kept boot time is read again: past a second's rounding of `btime`,
 * and under any step that would misjudge a marker written since.
 */
const CLOCK_STEP_MS = 1000;

/**
 * The wall clock's time at the monotonic clock's zero, which holds
 * still as time passes, and as the wall clock slews, since a slew
 * moves both clocks alike. It moves when the wall clock is stepped,
 * and on Linux across a suspend, which the monotonic clock doesn't
 * count: `btime` holds still then, so a suspend costs only a read.
 */
function wallAtMonotonicZero(): number {
	return Date.now() - performance.now();
}

/**
 * A boot time read through `read` the first time it answers, and kept
 * until the wall clock is stepped. The kernel's `btime` is the wall
 * clock less the time since boot, so a host started before its clock
 * was set would otherwise keep a boot off by the step for its whole
 * life, take markers written since for an earlier boot's, and clear
 * them. A machine that will not say, with no `/proc` or no `btime` in
 * it, is kept to that too, as it won't say later either. A read that
 * fails any other way is kept for nothing, so the next ask reads again:
 * a passing fault, such as a process out of file handles, mustn't leave
 * every marker unjudged.
 *
 * A forward step still misjudges what came before it: the boot read
 * after it is later by the step, so whatever this boot wrote less than
 * the step after it began reads as an earlier boot's, and a step longer
 * than the boot's age reaches everything before it. A park marker
 * written then is cleared. A mesh hold sent then stops standing, as a
 * reboot ends it: each hand already told it began is told it is over,
 * and a peer waiting on it is told the machine has restarted, though it
 * hasn't, with no word of a clock step. A peer's own
 * claims from then are let go when it next starts, and the boot the
 * restore file pinned as the last one is no longer kept, so the
 * records decide. Keeping the earlier boot instead would leave a peer
 * or a restore record from a boot that is over read as this one's, for
 * every reader of this time at once, so the later one is taken, as
 * `btime` itself gives.
 */
export function bootReadOnce(
	read: () => string,
	clock: () => number = wallAtMonotonicZero,
): Booted {
	let kept: (Reading & { readonly clock: number }) | undefined;
	return () => {
		const now = clock();
		if (kept && Math.abs(now - kept.clock) <= CLOCK_STEP_MS) return kept.at;
		const reading = bootedFrom(read);
		kept = reading && { ...reading, clock: now };
		return reading?.at;
	};
}

const kernelBooted = bootReadOnce(() => readFileSync("/proc/stat", "utf8"));

/** What a read told of the boot: when it was, or nothing where it won't say. */
interface Reading {
	readonly at: number | undefined;
}

/** The codes a read fails with where the machine has no `/proc` to read. */
const NO_PROC = new Set(["ENOENT", "ENOTDIR"]);

/**
 * The boot `read` tells of, or nothing for a fault that may pass, which
 * is worth reading again.
 */
function bootedFrom(read: () => string): Reading | undefined {
	try {
		const seconds = /^btime (\d+)$/m.exec(read())?.[1];
		return { at: seconds === undefined ? undefined : Number(seconds) * 1000 };
	} catch (error) {
		// No /proc, as on macOS, is the machine not saying, and stays so;
		// any other fault may pass. Either way nothing is judged by it now.
		return NO_PROC.has(errorCode(error)) ? { at: undefined } : undefined;
	}
}

function errorCode(error: unknown): string {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return "";
	}
	return String(error.code);
}
