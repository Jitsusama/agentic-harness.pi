/**
 * Where a path leads past its links, as a command writing it would
 * land: the one walk the fence's checks judge a path by, so none of
 * them can be walked round by a link the others follow.
 */

import { lstatSync, readlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** How many links a path may pass through before it counts as a loop. */
const MOST_LINKS = 40;

/**
 * Where `path` really leads, through every link in it, even where it
 * isn't there yet: a name not made yet lies where its folder leads, and
 * a link to nothing leads where writing through it would make the file,
 * its target read from where its own folder leads, as the system reads
 * it. Nothing when its links loop.
 *
 * It steps through each name as the system does rather than asking
 * realpath: node's folds `linked/..` as text before following the link,
 * where the system climbs from where the link leads, and the system's
 * own gives back a case-insensitive volume's spelling of each name, not
 * the one asked for, which the checks match their lists against.
 */
export function leadsTo(path: string, links = 0): string | undefined {
	if (links > MOST_LINKS) return undefined;
	const parent = dirname(path);
	if (parent === path) return path;
	const above = leadsTo(parent, links);
	if (above === undefined) return undefined;
	const name = basename(path);
	if (name === "." || name === "") return above;
	if (name === "..") return dirname(above);
	const here = join(above, name);
	let target: string | undefined;
	try {
		if (lstatSync(here).isSymbolicLink()) target = readlinkSync(here);
	} catch {
		// Nothing there at all: it would be made where its folder leads.
	}
	if (target === undefined) return here;
	// Not folded as text: a `..` in the target climbs from where it leads.
	const next = isAbsolute(target) ? target : `${above}${sep}${target}`;
	return leadsTo(next, links + 1);
}
