/**
 * Where stray writes are kept: one JSON line each, whole, with the
 * stack that made it, so the next one can be traced to its writer
 * without having to catch it on somebody's screen.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { StrayWrite } from "./guard.ts";
import type { StrayReport } from "./report.ts";

/** Past this size the log moves aside to `.1`, replacing the one there. */
export const LOG_MAX_BYTES = 4 * 1024 * 1024;

/** One kept write. */
export interface StrayEntry extends StrayWrite, StrayReport {
	readonly at: string;
	readonly session?: string;
}

/**
 * Add a write to the log. Never throws: a log that cannot be written
 * loses the entry, which is better than a warning that crashes pi.
 */
export function keepStray(path: string, entry: StrayEntry): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (sizeOf(path) > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch {
		// A full disk or a read-only home: the entry is lost, and there is
		// nowhere left to say so that would not be the screen.
	}
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		// Not written yet.
		return 0;
	}
}
