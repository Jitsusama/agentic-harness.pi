/**
 * The advisor's persisted on/off state.
 *
 * The advisor is off by default and turned on by asking for it in
 * conversation, not by an environment variable. The choice
 * persists to a small JSON file so it carries across sessions
 * until turned off again.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Read the advisor's enabled flag from `path`. Defaults to false
 * (off) when the file is missing or unreadable, so the advisor
 * never runs unless it was explicitly turned on.
 */
export function loadAdvisorEnabled(path: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return (parsed as { enabled?: unknown })?.enabled === true;
	} catch {
		// No settings file yet, or a corrupt one: stay off.
		return false;
	}
}

/** Persist the advisor's enabled flag to `path`. */
export function saveAdvisorEnabled(path: string, enabled: boolean): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}
