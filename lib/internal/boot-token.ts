/**
 * The token a machine mints as it boots, for telling what an earlier
 * boot left behind from what this one made, without trusting the clock.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Where Linux publishes a random identifier regenerated on each boot. */
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * Apple's own sysctl, by its path, so every session reads the same
 * program whatever its PATH holds: two that read different tokens would
 * each give up the other's running jobs.
 */
export const SYSCTL_PATH = "/usr/sbin/sysctl";

/** How long sysctl may take to name the boot on a Mac. */
export const BOOT_TOKEN_TIMEOUT_MS = 3000;

/**
 * How long a boot that couldn't be read is let be before it is read
 * again: sysctl, like getconf, can fail to start under load, and each
 * read can hold its caller for {@link BOOT_TOKEN_TIMEOUT_MS}.
 */
export const BOOT_TOKEN_AGAIN_MS = 30_000;

/**
 * Read an identifier for the running boot, or undefined when the host
 * offers none.
 *
 * Both platforms expose a uuid minted at boot rather than a
 * timestamp: Linux in procfs, macOS as `kern.bootsessionuuid`. The
 * neighbouring `kern.boottime` looks like the obvious source and is
 * not one, because it is derived from the clock and shifts when NTP
 * adjusts it. A token that drifts mid-boot would read everything this
 * boot made as left behind by an earlier one.
 *
 * `sysctl` names the program a Mac asks, Apple's own unless a test
 * stands in for it.
 */
export function readBootToken(sysctl = SYSCTL_PATH): string | undefined {
	if (process.platform === "linux") {
		try {
			return nonEmpty(readFileSync(LINUX_BOOT_ID_PATH, "utf8"));
		} catch {
			// No procfs (a container, an unusual mount): no token, and each
			// reader judges as it does while it has none.
			return undefined;
		}
	}
	try {
		return nonEmpty(
			execFileSync(sysctl, ["-n", "kern.bootsessionuuid"], {
				encoding: "utf8",
				timeout: BOOT_TOKEN_TIMEOUT_MS,
			}),
		);
	} catch {
		// No sysctl, the key absent, or no answer in time: no token rather
		// than a guess, read again later.
		return undefined;
	}
}

/** Trim a reading, treating blank output as no reading at all. */
function nonEmpty(raw: string): string | undefined {
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A boot token read through `read`, kept for good once read, since a
 * boot's identifier cannot change under the process reading it. A read
 * that found none is tried again once {@link BOOT_TOKEN_AGAIN_MS} has
 * passed on `now`, a clock that never steps, rather than leaving the
 * process with no token until it restarts. Each read holds its caller
 * for as long as it takes, so a sysctl that hangs rather than failing
 * costs up to {@link BOOT_TOKEN_TIMEOUT_MS} of every
 * {@link BOOT_TOKEN_AGAIN_MS}, as getconf's look costs the queue's folder
 * (paths.ts).
 */
export function bootTokenReader(
	read: () => string | undefined,
	now: () => number = () => performance.now(),
): () => string | undefined {
	let token: string | undefined;
	let missedAt: number | undefined;
	return () => {
		if (token !== undefined) return token;
		if (missedAt !== undefined && now() - missedAt < BOOT_TOKEN_AGAIN_MS)
			return undefined;
		token = read();
		missedAt = token === undefined ? now() : undefined;
		return token;
	};
}

/**
 * The identifier of the boot this process is running under, or
 * undefined while none can be read. Each reader says what it does
 * meanwhile: the queue's keeper leaves a stamped job to its pid until a
 * token reads (priority/folder.ts), and a liveness probe judges by the
 * pid and its start time alone.
 */
export const currentBootToken = bootTokenReader(() => readBootToken());
