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
 */
export function machineBooted(
	read: () => string = () => readFileSync("/proc/stat", "utf8"),
): number | undefined {
	try {
		const seconds = /^btime (\d+)$/m.exec(read())?.[1];
		return seconds === undefined ? undefined : Number(seconds) * 1000;
	} catch {
		// No /proc, as on macOS: the boot cannot be told, so nothing is
		// judged by it.
		return undefined;
	}
}
