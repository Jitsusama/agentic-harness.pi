/**
 * Process probes for the browser's own Chrome: whether a pid is still
 * the Chrome launched for a profile, and which processes still name a
 * profile. Both ask `ps`, synchronously, because one of them runs from
 * process exit, where nothing asynchronous gets to finish.
 */

import { execFileSync } from "node:child_process";

/**
 * How long one `ps` may take.
 *
 * While it waits nothing else in the process runs, and at exit that
 * means pi cannot quit. `ps` answers in milliseconds; one silent at
 * three seconds is not going to answer, and running out the clock
 * reads the safe way round: not ours to kill, and not known to be gone.
 */
export const PS_TIMEOUT_MS = 3000;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `command` carries this exact profile as its
 * --user-data-dir. Both sides of the value are anchored, so neither a
 * longer sibling path nor a differently-prefixed flag can collide.
 */
export function namesProfile(command: string, profileDir: string): boolean {
	return new RegExp(
		`(?:^|\\s)--user-data-dir=${escapeRegExp(profileDir)}(?:\\s|$)`,
	).test(command);
}

/**
 * Confirm a single pid is still the Chrome we launched for `profileDir`,
 * by matching its --user-data-dir argument exactly. This guards the
 * kill against a reused pid now owned by an unrelated process.
 */
export function verifyBrowser(pid: number, profileDir: string): boolean {
	try {
		const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			timeout: PS_TIMEOUT_MS,
		});
		return namesProfile(cmd, profileDir);
	} catch {
		return false;
	}
}

/**
 * Pids that still name `profileDir` as their --user-data-dir, matched
 * as an exact argument so a longer sibling path never collides. Used
 * only to rediscover an orphan whose owner is already proven dead.
 */
export function findProcsByProfile(profileDir: string): number[] | undefined {
	try {
		const out = execFileSync("ps", ["-eo", "pid=,command="], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			timeout: PS_TIMEOUT_MS,
		});
		const pids: number[] = [];
		for (const line of out.split("\n")) {
			if (!namesProfile(line, profileDir)) continue;
			const pid = Number.parseInt(line.trim(), 10);
			if (Number.isFinite(pid) && pid !== process.pid) pids.push(pid);
		}
		return pids;
	} catch {
		// The probe itself failed: signal "unknown", not "none", so a
		// still-running orphan is not mistaken for an empty result.
		return undefined;
	}
}
