/**
 * An install of this harness kept as pi-packages keeps one, for a case
 * about a hosted conversation following it: a folder of versions, each a
 * copy of this tree, and a `current` link moved between them in one
 * rename.
 */

import { cpSync, renameSync, symlinkSync, utimesSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** This tree, which each version is a copy of. */
const HARNESS = resolve(import.meta.dirname, "../../../..");

/** What a version of the install leaves out of the tree, at its top. */
const LEFT_OUT = new Set(["node_modules", ".git", "tests"]);

/**
 * A version of the install under `versions`: this tree's code, sharing
 * its installed dependencies, with a lockfile older than their install
 * record, so the follower takes it as installed.
 */
export function version(install: string, name: string): string {
	const folder = join(install, "versions", name);
	cpSync(HARNESS, folder, {
		recursive: true,
		filter: (from) => !LEFT_OUT.has(relative(HARNESS, from)),
	});
	symlinkSync(join(HARNESS, "node_modules"), join(folder, "node_modules"));
	utimesSync(join(folder, "pnpm-lock.yaml"), 0, 0);
	return folder;
}

/** Move the install's link onto `name` in one rename, as pi-packages does. */
export function moveTo(install: string, name: string): void {
	const link = join(install, "current");
	symlinkSync(join("versions", name), `${link}.new`);
	renameSync(`${link}.new`, link);
}
