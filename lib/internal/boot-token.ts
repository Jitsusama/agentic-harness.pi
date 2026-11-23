/**
 * The token a machine mints as it boots, for telling what an earlier
 * boot left behind from what this one made, without trusting the clock.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Where Linux publishes a random identifier regenerated on each boot. */
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/** How long sysctl may take to name the boot on a Mac. */
export const BOOT_TOKEN_TIMEOUT_MS = 3000;

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
 */
function readBootToken(): string | undefined {
	if (process.platform === "linux") {
		try {
			return nonEmpty(readFileSync(LINUX_BOOT_ID_PATH, "utf8"));
		} catch {
			// No procfs (a container, an unusual mount): no token, so a
			// reader falls back to what it judged by before tokens.
			return undefined;
		}
	}
	try {
		return nonEmpty(
			execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], {
				encoding: "utf8",
				timeout: BOOT_TOKEN_TIMEOUT_MS,
			}),
		);
	} catch {
		// No sysctl, or the key is absent on this platform: same again,
		// no token rather than a guess.
		return undefined;
	}
}

/** Trim a reading, treating blank output as no reading at all. */
function nonEmpty(raw: string): string | undefined {
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Memoized boot token; a boot identifier cannot change under us. */
let bootTokenCache: { token: string | undefined } | undefined;

/**
 * The identifier of the boot this process is running under, read once
 * and remembered. Undefined on a host that publishes none, in which
 * case nothing is ever judged by boot.
 */
export function currentBootToken(): string | undefined {
	bootTokenCache ??= { token: readBootToken() };
	return bootTokenCache.token;
}
