/**
 * Where a session's work is, as parking asks: its folder and the trees
 * the work tool cut for it, and the repositories those are clones of.
 *
 * Only a stop on a repository or a name asks, so a session pays for the
 * git lookups only while one stands.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The folders a session works in: its own, then each tree cut for it. */
export function dirsOf(session: string, cwd: string, cuts: string): string[] {
	const dirs = [cwd];
	let names: string[];
	try {
		names = readdirSync(cuts);
	} catch {
		// No work records: the session works in its own folder alone.
		return dirs;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const record = JSON.parse(readFileSync(join(cuts, name), "utf8")) as {
				path?: unknown;
				sessions?: unknown;
			} | null;
			const holds =
				Array.isArray(record?.sessions) && record.sessions.includes(session);
			if (holds && typeof record?.path === "string") dirs.push(record.path);
		} catch {
			// Half written or gone: that tree is left out this time.
		}
	}
	return [...new Set(dirs)];
}

/** The repositories of `dirs`, as `owner/name`, asked of each one's origin. */
export async function reposOf(
	dirs: readonly string[],
	repoOf: (dir: string) => Promise<string | undefined>,
): Promise<string[]> {
	const repos = await Promise.all(dirs.map(repoOf));
	return [
		...new Set(repos.filter((repo): repo is string => repo !== undefined)),
	];
}
