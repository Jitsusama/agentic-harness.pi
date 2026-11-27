/**
 * Whether a session carries on code its install has long left behind.
 *
 * A session follows its install, reloading once idle after the install
 * moves (lib/internal/reload/follow.ts), though not every session follows,
 * and one that does can miss it: on 27
 * November MZ5YL7 carried on a harness two days old, which lacked the
 * fix for the very failure its carry met. A carry it starts then fails
 * on a bug already mended, so it waits for the reload instead, saying
 * why.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { installOfVersion } from "../reload/loaded.ts";

/** How many characters of a version's commit a refusal names. */
const SHORT_SHA = 12;

/** Milliseconds in a minute, for the refusal's count. */
const MINUTE_MS = 60_000;

/**
 * How long a session may run a version its install has left before a
 * carry from it waits on its reload: the follower's spread of idle
 * reloads, ten minutes, with room for the install to finish. A shorter
 * bar would refuse carries often, since the install moves many times an
 * hour while sessions reload on their own.
 */
export const BEHIND_FOR_MS = 15 * 60_000;

/**
 * Why a carry from the harness at `root` waits on its reload, `now`:
 * the install `root` is a version of has left it for another more than
 * {@link BEHIND_FOR_MS} ago. Nothing for the install's own version, or
 * for code outside an install of whole versions, such as a tree or a
 * store copy.
 */
export function behindItsInstall(
	root: string,
	now: number = Date.now(),
): string | undefined {
	const install = installOfVersion(root);
	if (install === undefined) return undefined;
	let current: string;
	let running: string;
	try {
		current = realpathSync(join(install, "current"));
		running = realpathSync(root);
	} catch {
		// A link onto nothing, or a version gone: nothing to come up to.
		return undefined;
	}
	if (current === running) return undefined;
	const left = leftAt(running);
	if (left === undefined || now - left <= BEHIND_FOR_MS) return undefined;
	const minutes = Math.floor((now - left) / MINUTE_MS);
	return `it runs harness ${short(running)}, which its install left ${minutes} minutes ago for ${short(current)}, so it may lack a carry fix; ask the carry again once it reloads, which /reload does now and a session following its install does once idle`;
}

/**
 * When the install left the version at `running`: when the first version
 * beside it made after it was made, or nothing where none was. A version
 * since let go makes this later than it was, which errs toward carrying.
 */
function leftAt(running: string): number | undefined {
	const versions = dirname(running);
	let made: number;
	let names: string[];
	try {
		made = statSync(running).mtimeMs;
		names = readdirSync(versions);
	} catch {
		// Versions that can't be read say nothing of when it was left.
		return undefined;
	}
	let first: number | undefined;
	for (const name of names) {
		let at: number;
		try {
			at = statSync(join(versions, name)).mtimeMs;
		} catch {
			// One let go as it was read was not the one that left it.
			continue;
		}
		if (at > made && (first === undefined || at < first)) first = at;
	}
	return first;
}

/** A version folder's commit, as a refusal names it. */
function short(version: string): string {
	return basename(version).slice(0, SHORT_SHA);
}
