/**
 * Killing a Chrome and its helpers, and reaping the trees and
 * profile directories a dead owner left behind.
 *
 * Kept apart from the launch because each step here signals a
 * process, and the rules for when that is safe (a group, a re-verify
 * at signalling time, a directory kept while anything names it)
 * change for reasons of their own. Signal delivery and every probe
 * are injectable, so the rules are testable without a Chrome.
 */

import * as path from "node:path";

/** Signal delivery, injectable so the reaping logic is testable. */
type GroupKill = (pid: number, signal: string) => void;

const defaultGroupKill: GroupKill = (pid, signal) => {
	process.kill(pid, signal);
};

/**
 * Kill a detached Chrome's whole process group, falling back to the
 * bare pid. Chrome is spawned detached, so its pgid equals its pid;
 * the negative pid reaps every helper (GPU, network, renderers) that
 * a lone pid kill would leave to reparent to launchd.
 */
export function killPidGroup(
	pid: number,
	groupKill: GroupKill = defaultGroupKill,
): void {
	try {
		groupKill(-pid, "SIGKILL");
	} catch {
		// The group is gone or unkillable; try the leader on its own.
		try {
			groupKill(pid, "SIGKILL");
		} catch {
			// Nothing left to kill; the process already exited.
		}
	}
}

/** Kill a live browser process tree: group first, then proc.kill fallback. */
export function killTree(
	proc:
		| { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }
		| null
		| undefined,
	groupKill: GroupKill = defaultGroupKill,
): void {
	const pid = proc?.pid;
	if (!proc || !pid) return;
	try {
		groupKill(-pid, "SIGKILL");
	} catch {
		// Group kill failed; fall back to Puppeteer's own process handle.
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already dead.
		}
	}
}

/** What a process records about the Chrome it owns, written into its profile dir. */
export interface OwnerRecord {
	/** Pid of the owning process. */
	ownerPid: number;
	/** Pid (and process-group leader) of the Chrome this process launched. */
	browserPid?: number;
}

/** Inputs for reaping Chrome trees and profile dirs a dead owner left behind. */
export interface ReapOrphansOptions {
	root: string;
	listEntries: () => string[];
	readOwner: (profileDir: string) => OwnerRecord | undefined;
	isPidAlive: (pid: number) => boolean;
	verifyBrowser: (pid: number, profileDir: string) => boolean;
	/** Pids naming this exact profile, or undefined when the probe failed. */
	findProcsByProfile: (profileDir: string) => number[] | undefined;
	killPid: (pid: number) => void;
	removeDir: (dir: string) => void;
}

/**
 * True when a profile's owning process is still running. Liveness is keyed
 * on the pid alone: a generation-unique profile directory means a
 * reused pid can never collide with a live owner's directory, so a
 * pid that is alive is treated as the owner and kept. This fails
 * closed, a reused pid only ever leaks a stale directory rather than
 * killing a live browser.
 */
function ownerAlive(
	opts: ReapOrphansOptions,
	entry: string,
	owner: OwnerRecord | undefined,
): boolean {
	const pid = owner ? owner.ownerPid : Number.parseInt(entry, 10);
	return Number.isFinite(pid) && opts.isPidAlive(pid);
}

/** True when a probe reports the pid still names this exact profile. */
function stillOurs(
	opts: ReapOrphansOptions,
	pid: number,
	dir: string,
): boolean {
	try {
		return opts.verifyBrowser(pid, dir);
	} catch {
		// Cannot confirm, so treat it as still present and fail safe.
		return true;
	}
}

/**
 * Reap Chrome trees and profile dirs a prior run left behind. Each
 * dir is reaped only when its owning process is dead. The candidate kill
 * set is the exact-profile matches unioned with a recorded pid; each
 * candidate is re-verified immediately before it is signalled, so a
 * pid that exited and was reused is never group-killed. The dir is
 * removed only once discovery has run and a fresh check confirms no
 * candidate still names it, so a failed probe or a surviving process
 * keeps the dir for a later sweep. Every step is best-effort: one bad
 * entry can never abort the sweep or block a launch.
 */
export function reapOrphans(opts: ReapOrphansOptions): void {
	for (const entry of opts.listEntries()) {
		try {
			const dir = path.join(opts.root, entry);
			let owner: OwnerRecord | undefined;
			try {
				owner = opts.readOwner(dir);
			} catch {
				// Unreadable record; treat as no record.
			}
			if (ownerAlive(opts, entry, owner)) continue;

			const discovered = opts.findProcsByProfile(dir);
			const candidates = new Set<number>(discovered ?? []);
			if (owner?.browserPid) candidates.add(owner.browserPid);
			for (const pid of candidates) {
				// Re-verify at signalling time: a stale discovery entry or a
				// pid that has since been reused must not be group-killed.
				if (!stillOurs(opts, pid, dir)) continue;
				try {
					opts.killPid(pid);
				} catch {
					// Lost a race with the process exiting; a later sweep
					// reclaims the dir.
				}
			}

			// Remove the dir only when discovery ran and nothing we targeted
			// still names the profile. A failed probe or a survivor keeps it.
			if (discovered === undefined) continue;
			const cleared = [...candidates].every(
				(pid) => !stillOurs(opts, pid, dir),
			);
			if (!cleared) continue;
			try {
				opts.removeDir(dir);
			} catch {
				// A busy or unreadable dir must not block launches; the next
				// startup sweeps whatever this one could not.
			}
		} catch {
			// Defensive: never let one entry abort the whole sweep.
		}
	}
}
