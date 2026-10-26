/**
 * Where Chrome is on this machine.
 *
 * The places an installer puts it come first, since those are where a
 * person who installed it by hand would look. A distribution that keeps
 * programs somewhere else, as NixOS and Guix do, puts them on PATH, so
 * the names Chrome and Chromium go by are looked for there next.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAC_APPS = [
	"Google Chrome.app/Contents/MacOS/Google Chrome",
	"Chromium.app/Contents/MacOS/Chromium",
];

const INSTALLED_PATHS = [
	...MAC_APPS.map((app) => path.join("/Applications", app)),
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	// Ubuntu ships Chromium as a snap, which lands here and on no
	// other path in this list.
	"/snap/bin/chromium",
];

const NAMES_ON_PATH = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
];

/** Whether a path is there, treating an unreadable path as absent. */
function present(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		// An unreadable path is no use to us either way, so it counts
		// as absent and the caller moves on.
		return false;
	}
}

/** Whether a path is a program we may run, treating an unreadable one as absent. */
export function runnable(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/**
 * The first Chrome found, at an installed path or on the search path.
 *
 * @param searchPath - The directories to look in, as PATH spells them.
 * @param isRunnable - Whether a path is a program; replaced in tests.
 */
export function findChrome(
	searchPath: string | undefined = process.env.PATH,
	isRunnable: (p: string) => boolean = runnable,
): string {
	const onPath = (searchPath ?? "")
		.split(path.delimiter)
		.filter((dir) => dir !== "")
		.flatMap((dir) => NAMES_ON_PATH.map((name) => path.join(dir, name)));
	// A Mac install for one person goes in their own Applications.
	const personal = MAC_APPS.map((app) =>
		path.join(os.homedir(), "Applications", app),
	);
	const found = [...INSTALLED_PATHS, ...personal, ...onPath].find(isRunnable);
	if (found) return found;
	throw new Error(
		"Chrome not found. Install Google Chrome or set CHROME_PATH.",
	);
}

/**
 * Settle on the binary to launch, refusing a configured path that is
 * not there.
 *
 * CHROME_PATH used to be taken on trust, so a stale or mistyped
 * value fell through to the launch loop: three attempts, two
 * backoffs, and then a message whose first line blamed a Chrome
 * auto-update. None of that is true of a path that does not exist,
 * and no amount of retrying fixes it. A missing Chrome was already
 * treated as the settled misconfig it is; this is the same fault
 * arriving by a different door.
 */
export function resolveChromePath(
	configured: string | undefined,
	exists: (p: string) => boolean = present,
): string {
	if (!configured) return findChrome();
	if (!exists(configured))
		throw new Error(
			`CHROME_PATH is set to ${configured}, which does not exist. ` +
				"Point it at a Chrome or Chromium binary, or unset it to use " +
				"the installed browser.",
		);
	return configured;
}
