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

import { lstatSync, realpathSync, statSync } from "node:fs";
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
 * When `install` left the version at `running`: the time of the empty
 * marker its installer makes in `retired/` as it moves `current` off a
 * version, named by that version's commit and dated to the move. With
 * no marker, as for a session on the former `releases/`, it is the time
 * of the `current` link itself, which moved no earlier than it left
 * `running`, so it errs toward carrying. Nothing where neither can be
 * read, so a doubt never refuses. When versions were made says nothing
 * of it: one is built long before it is made current, if ever, and a
 * copy keeps its times.
 */
function leftAt(install: string, running: string): number | undefined {
	try {
		return statSync(join(install, "retired", basename(running))).mtimeMs;
	} catch {
		// No marker, as for a version left before markers were kept.
	}
	try {
		return lstatSync(join(install, "current")).mtimeMs;
	} catch {
		// An install whose link can't be read says nothing of the move.
		return undefined;
	}
}

/** The commit a version folder holds, less what a rebuild adds. */
function commitOf(version: string): string {
	return basename(version).split(REBUILT)[0] ?? "";
}

/** A version folder's commit, as a refusal names it. */
function short(version: string): string {
	return basename(version).slice(0, SHORT_SHA);
}
