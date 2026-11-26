/**
 * When this machine booted, which bounds what is still under way: a
 * process, a holder or a marker from before it belongs to a boot that
 * is over. The mesh's liveness, the restore record and park markers
 * all judge by it, so it lives below each of them.
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

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
	return read === undefined ? kernelBooted() : bootedFrom(read);
}

/**
 * How far the wall clock may move against the monotonic one before a
 * kept boot time is read again: past what a second's rounding of
 * `btime` and a slewing clock's drift would move it, and under any
 * step that would misjudge a marker written since.
 */
const CLOCK_STEP_MS = 1000;

/**
 * The wall clock's time at the monotonic clock's zero, which moves only
 * when the wall clock is stepped or slewed, never as time passes.
 */
function wallAtMonotonicZero(): number {
	return Date.now() - performance.now();
}

/**
 * A boot time read through `read` the first time it answers, and kept
 * until the wall clock is stepped. A read that fails, or names no boot,
 * is kept for nothing, so the next ask reads again: a passing fault,
 * such as a process out of file handles, mustn't leave every marker
 * unjudged. The kernel's `btime` is the wall clock less the time since
 * boot, so a host started before its clock was set would otherwise keep
 * a boot off by the step for its whole life, and take markers written
 * since for an earlier boot's, and clear them.
 */
export function bootReadOnce(
	read: () => string,
	clock: () => number = wallAtMonotonicZero,
): Booted {
	let kept: { readonly at: number; readonly clock: number } | undefined;
	return () => {
		const now = clock();
		if (kept && Math.abs(now - kept.clock) <= CLOCK_STEP_MS) return kept.at;
		const at = bootedFrom(read);
		kept = at === undefined ? undefined : { at, clock: now };
		return at;
	};
}

const kernelBooted = bootReadOnce(() => readFileSync("/proc/stat", "utf8"));

function bootedFrom(read: () => string): number | undefined {
	try {
		const seconds = /^btime (\d+)$/m.exec(read())?.[1];
		return seconds === undefined ? undefined : Number(seconds) * 1000;
	} catch {
		// No /proc, as on macOS: the boot cannot be told, so nothing is
		// judged by it.
		return undefined;
	}
}
