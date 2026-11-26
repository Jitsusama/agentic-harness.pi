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
 * The kernel's `btime` drifts by seconds as the clock is corrected,
 * which a judgement of which boot something is from never feels; a
 * process's start, which does, reads it fresh (`process-ticks.ts`).
 */
export function machineBooted(read?: () => string): number | undefined {
	return read === undefined ? kernelBooted() : bootedFrom(read);
}

/**
 * A boot time read through `read` the first time it answers, and kept
 * from then on. A read that fails, or names no boot, is kept for
 * nothing, so the next ask reads again: a passing fault, such as a
 * process out of file handles, mustn't leave every marker unjudged.
 */
export function bootReadOnce(read: () => string): Booted {
	let kept: number | undefined;
	return () => {
		kept ??= bootedFrom(read);
		return kept;
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
