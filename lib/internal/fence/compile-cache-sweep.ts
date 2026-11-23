/**
 * Sweeping node's compile cache in the runtime folder. node keeps an
 * entry for each module it compiles and never removes one, and every
 * install of the harness lies at a path of its own, so each adds a new
 * set: in pi's state the cache grew about 70 MB a day from 20 to 22
 * November, by its files' dates. The runtime folder is memory, so what
 * no process reads any more is removed: an entry neither written nor
 * read for a day, as its times say. One swept while still in use is
 * only compiled again. A host start sweeps at most once an hour, as a
 * stamp in the folder says, so a storm of child starts walks it once.
 */

import {
	lstatSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** How long an entry may lie unread and unwritten before it is swept. */
export const IDLE_COMPILED_MS = 24 * 60 * 60 * 1000;

/** How long after one sweep a host start leaves the folder alone. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000;

/** The file whose time says when the folder was last swept. */
const STAMP = ".swept";

/** What a sweep did: whether it walked the folder, and what it removed. */
export interface Swept {
	readonly walked: boolean;
	readonly removed: number;
}

/**
 * Remove the entries under `folder` neither read nor written within
 * `idleMs` of `now`, unless it was swept within `everyMs`. Links are
 * removed by their own times and never followed. Never throws: an
 * entry that can't be read or removed is left for the next sweep.
 */
export function sweepIdleCompiled(
	folder: string,
	now: number = Date.now(),
	idleMs: number = IDLE_COMPILED_MS,
	everyMs: number = SWEEP_EVERY_MS,
): Swept {
	const stamp = join(folder, STAMP);
	if (sweptWithin(stamp, now, everyMs)) return { walked: false, removed: 0 };
	try {
		writeFileSync(stamp, "");
		const at = new Date(now);
		utimesSync(stamp, at, at);
	} catch {
		// No folder to sweep, or none to stamp: nothing is lost but a walk
		// the next start makes again.
		return { walked: false, removed: 0 };
	}
	return { walked: true, removed: sweepUnder(folder, now - idleMs, stamp) };
}

/** Whether `stamp` says a sweep ran within `everyMs` of `now`. */
function sweptWithin(stamp: string, now: number, everyMs: number): boolean {
	try {
		const at = statSync(stamp).mtimeMs;
		return at <= now && now - at < everyMs;
	} catch {
		// No stamp yet: never swept.
		return false;
	}
}

/** Remove what under `folder` was last used before `before`, but `stamp`. */
function sweepUnder(folder: string, before: number, stamp: string): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(folder);
	} catch {
		// Gone or unreadable: nothing here to sweep.
		return 0;
	}
	for (const entry of entries) {
		const path = join(folder, entry);
		if (path === stamp) continue;
		try {
			const stat = lstatSync(path);
			if (stat.isDirectory()) removed += sweepUnder(path, before, stamp);
			else if (Math.max(stat.mtimeMs, stat.atimeMs) < before) {
				rmSync(path, { force: true });
				removed += 1;
			}
		} catch {
			// Removed by another start meanwhile, or unreadable: left for the
			// next sweep.
		}
	}
	return removed;
}
