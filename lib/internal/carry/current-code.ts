/**
 * Whether a session carries on code its install has long left behind.
 *
 * A session follows its install, reloading once idle after the install
 * moves (lib/internal/reload/follow.ts), though not every session follows,
 * and one that does can miss it: on 27
 * November MZ5YL7 carried on a harness two days old, which lacked the
 * fix for the very failure its carry met. A carry it starts then fails
 * on a bug already mended, so it waits for the reload instead, saying
 * why. When the install left a version is read from the installer's own
 * record of moving off it, never from when version folders were made.
 */

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { installOfVersion } from "../reload/loaded.ts";

/** How many characters of a version's commit a refusal names. */
const SHORT_SHA = 12;

/**
 * What separates a commit from when its version was built again, in the
 * folder of a rebuild, as core.nix's pi-packages names it.
 */
const REBUILT = "+";

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
 * {@link BEHIND_FOR_MS} ago. Nothing for the install's own commit, in
 * whichever folder or rebuild it runs from, or
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
	// One commit can sit in two folders, or be built again, and runs the
	// same code in each.
	if (commitOf(current) === commitOf(running)) return undefined;
	const left = leftAt(install, running);
	if (left === undefined || now - left <= BEHIND_FOR_MS) return undefined;
	const minutes = Math.floor((now - left) / MINUTE_MS);
	return `it runs harness ${short(running)}, which its install left ${minutes} minutes ago for ${short(current)}, so it may lack a carry fix; ask the carry again once it reloads, which /reload does now and a session following its install does once idle`;
}

/**
 * When `install` left the commit at `running`: the latest of the empty
 * markers its installer makes in `retired/` as it moves `current` off a
 * version folder, each named by that folder and dated to the move, of
 * every folder holding the commit. A move from one rebuild of a commit
 * to another leaves none of its code, so only the last move off any of
 * them says when the commit was left. With no marker, as for a session
 * on the former `releases/`, it is the time of the `current` link
 * itself, which moved no earlier than it left `running`, so it errs
 * toward carrying. Nothing where neither can be read, so a doubt never
 * refuses. When versions were made says nothing of it: one is built
 * long before it is made current, if ever, and a copy keeps its times.
 */
function leftAt(install: string, running: string): number | undefined {
	const marked = markedLeaving(join(install, "retired"), commitOf(running));
	if (marked !== undefined) return marked;
	try {
		return lstatSync(join(install, "current")).mtimeMs;
	} catch {
		// An install whose link can't be read says nothing of the move.
		return undefined;
	}
}

/**
 * The latest time `retired` marks a folder of `commit` as left, or
 * nothing where none is marked or the markers can't be read.
 */
function markedLeaving(retired: string, commit: string): number | undefined {
	let names: string[];
	try {
		names = readdirSync(retired);
	} catch {
		// No markers kept, as before the installer kept them.
		return undefined;
	}
	let latest: number | undefined;
	for (const name of names) {
		if (commitOf(name) !== commit) continue;
		try {
			const at = statSync(join(retired, name)).mtimeMs;
			if (latest === undefined || at > latest) latest = at;
		} catch {
			// Swept with its version while read: it marks no leaving now.
		}
	}
	return latest;
}

/** The commit a version folder holds, less what a rebuild adds. */
function commitOf(version: string): string {
	return basename(version).split(REBUILT)[0] ?? "";
}

/** A version folder's commit, as a refusal names it. */
function short(version: string): string {
	return basename(version).slice(0, SHORT_SHA);
}
