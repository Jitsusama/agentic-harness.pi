/**
 * Where a carried tree may be put: the work broker's trees, or a folder
 * of the person's own under home that no dot hides, such as `~/src/app`.
 * A done file names each tree's place, and whoever can write one could
 * otherwise have an arrival clone a repository wherever this login may
 * write, such as a folder pi loads extensions from, so any other place
 * is refused, and so is one a link leads out of these.
 */

import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { real, within } from "../sandbox/tree-git.ts";

/**
 * Why a tree may not be put at `path`, as its links really lead, given
 * `home` and the broker's `trees`; nothing where it may.
 */
export function placeRefused(
	path: string,
	home: string,
	trees: string,
): string | undefined {
	const really = asItLeads(path);
	if (within(really, trees)) return undefined;
	const inside = relative(real(home), really);
	const outside =
		inside === "" ||
		inside === ".." ||
		inside.startsWith(`..${sep}`) ||
		isAbsolute(inside);
	if (outside) {
		return `Its done file places it at ${path}, outside the person's home and the work broker's trees, so it isn't put there.`;
	}
	if (inside.split(sep).some((part) => part.startsWith("."))) {
		return `Its done file places it at ${path}, in a hidden folder outside the work broker's trees, where a tree may be read as settings or code to load, so it isn't put there.`;
	}
	return undefined;
}

/** `path` past every link in the part of it that stands. */
function asItLeads(path: string): string {
	const rest: string[] = [];
	let at = path;
	while (!existsSync(at) && dirname(at) !== at) {
		rest.unshift(basename(at));
		at = dirname(at);
	}
	return join(real(at), ...rest);
}
