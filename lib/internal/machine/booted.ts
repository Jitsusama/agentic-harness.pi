/**
 * When this machine booted, which bounds what is still under way: a
 * process, a holder or a marker from before it belongs to a boot that
 * is over. The mesh's liveness, the restore record and park markers
 * all judge by it, so it lives below each of them.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** When the machine booted, in milliseconds since the epoch, if it says. */
export type Booted = () => number | undefined;

/** How long `sysctl` may take to answer before the boot is left untold. */
const SYSCTL_WAIT_MS = 2000;

/** What macOS's `sysctl -n kern.boottime` said, read once a process: a boot doesn't move while it runs. */
let macBoot: string | undefined;

/** What the machine says of its boot: Linux's `/proc/stat`, or macOS's `kern.boottime`, since a Mac has no `/proc`. */
function bootSaid(): string {
	if (process.platform !== "darwin") return readFileSync("/proc/stat", "utf8");
	macBoot ??= execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
		encoding: "utf8",
		timeout: SYSCTL_WAIT_MS,
	});
	return macBoot;
}

/**
 * When the machine booted, in milliseconds since the epoch: the kernel's
 * `btime` on Linux, or the seconds and microseconds of `kern.boottime`
 * on macOS; nothing where the machine will not say. Nothing a peer
 * started before then is under way any more.
 */
export function machineBooted(
	read: () => string = bootSaid,
): number | undefined {
	try {
		const said = read();
		const btime = /^btime (\d+)$/m.exec(said)?.[1];
		if (btime !== undefined) return Number(btime) * 1000;
		const mac = /\{\s*sec = (\d+), usec = (\d+)\s*\}/.exec(said);
		if (mac?.[1] === undefined || mac[2] === undefined) return undefined;
		return Number(mac[1]) * 1000 + Math.floor(Number(mac[2]) / 1000);
	} catch {
		// Neither /proc nor a sysctl that answers: the boot cannot be
		// told, so nothing is judged by it.
		return undefined;
	}
}
