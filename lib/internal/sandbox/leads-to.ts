/**
 * Where a path leads past its links, as a command writing it would
 * land: the one walk the fence's checks judge a path by, so none of
 * them can be walked round by a link the others follow.
 */

import { Buffer } from "node:buffer";
import { lstatSync, readlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/**
 * How many links one walk may follow in all before it gives up, as the
 * system counts them: 40 on Linux, 32 on a Mac.
 */
export const MOST_LINKS = process.platform === "darwin" ? 32 : 40;

/** What a look at a name says when nothing stands there to follow. */
const NOTHING_THERE = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Where `path` really leads, through every link in it, even where it
 * isn't there yet: a name not made yet lies where its folder leads, and
 * a link to nothing leads where writing through it would make the file,
 * its target read from where its own folder leads, as the system reads
 * it. Nothing when it can't be said: its links loop or run past the
 * system's count, a name can't be looked at, or a link's target isn't
 * text this walk can name.
 *
 * It steps through each name as the system does rather than asking
 * realpath: node's folds `linked/..` as text before following the link,
 * where the system climbs from where the link leads, and the system's
 * own gives back a case-insensitive volume's spelling of each name, not
 * the one asked for, which the checks match their lists against.
 *
 * It judges the path as the system is handed it. pi's own tools fold
 * `..` as text before they ask (tool-path.ts), so the fence's checks
 * hand it the path folded so, which is where those tools write.
 *
 * A relative path is looked at from the process's folder, as the system
 * would look at it, and stays relative, its leading `..` kept. The links
 * are counted across the whole walk, as the system counts them, so links
 * that fan out to each other cost no more than one chain of that length.
 * The names still to walk are held in a list, so the walk can say every
 * link it met and stop at the first it can't follow.
 */
export function leadsTo(path: string): string | undefined {
	return walk(path).to;
}

/**
 * Every link the walk to `path` met, each where it really lies, as far
 * as the walk went: what `path` leads to is decided by each of them, so a
 * command that may change one may send `path` anywhere, and one whose
 * links can't be followed now may be made to lead somewhere later.
 */
export function linksOn(path: string): readonly string[] {
	return [...walk(path).met];
}

/** The walk behind {@link leadsTo} and {@link linksOn}. */
function walk(path: string): {
	readonly to: string | undefined;
	readonly met: ReadonlySet<string>;
} {
	const met = new Set<string>();
	let at = isAbsolute(path) ? sep : ".";
	const left = namesOf(path);
	let links = MOST_LINKS;
	for (let name = left.pop(); name !== undefined; name = left.pop()) {
		if (name === "." || name === "") continue;
		if (name === "..") {
			at = climbed(at);
			continue;
		}
		const here = join(at, name);
		const target = linkAt(here);
		if (target === undefined) return { to: undefined, met };
		if (target === NOT_A_LINK) {
			at = here;
			continue;
		}
		met.add(here);
		if (target === UNREADABLE_LINK || links === 0)
			return { to: undefined, met };
		links -= 1;
		// Not folded as text: a `..` in the target climbs from where it leads.
		if (isAbsolute(target)) at = sep;
		left.push(...namesOf(target));
	}
	return { to: at, met };
}

/**
 * Where `path` leads past its links, or where they can't be followed,
 * where its folder leads with its own name as spelled: a folder whose
 * links loop still lies in the folder that holds it. Each level is walked
 * afresh, so a path that can't be followed costs at most one walk per
 * name in it.
 */
export function landsAt(path: string): string {
	const led = leadsTo(path);
	if (led !== undefined) return led;
	const parent = dirname(path);
	return parent === path ? path : join(landsAt(parent), basename(path));
}

/** What {@link linkAt} answers for a name that is no link, or not there. */
const NOT_A_LINK = Symbol("not a link");

/** What {@link linkAt} answers for a link whose target it can't name. */
const UNREADABLE_LINK = Symbol("a link it can't read");

/**
 * The target of the link at `path`, NOT_A_LINK where nothing there is a
 * link, UNREADABLE_LINK where a link is there but its target can't be
 * named (it can't be read, or isn't UTF-8, which read as text would name
 * another file than the system follows), or undefined where a look at
 * the name fails for any reason but nothing being there.
 */
function linkAt(
	path: string,
): string | typeof NOT_A_LINK | typeof UNREADABLE_LINK | undefined {
	let link: boolean;
	try {
		link = lstatSync(path).isSymbolicLink();
	} catch (error) {
		return isNothingThere(error) ? NOT_A_LINK : undefined;
	}
	if (!link) return NOT_A_LINK;
	try {
		const raw = readlinkSync(path, { encoding: "buffer" });
		const target = raw.toString("utf8");
		return Buffer.from(target, "utf8").equals(raw) ? target : UNREADABLE_LINK;
	} catch {
		// Gone or changed since the look, or one this process may not read,
		// as /proc/1/root is to all but its owner: still a link the walk met,
		// whose target is not known.
		return UNREADABLE_LINK;
	}
}

/** Whether a failed look says nothing stands at the name. */
function isNothingThere(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		NOTHING_THERE.has(error.code)
	);
}

/** The names of `path`, the first last, as the walk takes them. */
function namesOf(path: string): string[] {
	return path.split(sep).reverse();
}

/** The folder above `folder`, kept as a `..` where a relative one runs out. */
function climbed(folder: string): string {
	return folder === "." || basename(folder) === ".."
		? join(folder, "..")
		: dirname(folder);
}
