/**
 * Where an arriving carry may put a tree. A done file names each tree's
 * place, and whoever can write one could otherwise have an arrival
 * clone a repository wherever this login may write: into a folder pi
 * loads extensions from, onto the PATH, or into another tree's own
 * settings. So a place is taken only where trees and checkouts already
 * go, and everything else is refused, since the carry can't tell which
 * other folders something loads from:
 *
 * - the work broker's trees, as a tree of its own directly within them,
 *   under a name no dot hides;
 * - a folder under home's `src` or `world`, where checkouts lie, that no
 *   dot hides at any part and that lies inside no other checkout.
 *
 * Each is judged as its links really lead, the place's and the trees'
 * and home's alike, and a link that leads nowhere is refused, since
 * where it would lead can't be told.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** The folders under home that checkouts lie in. */
const CHECKOUT_ROOTS = ["src", "world"] as const;

/**
 * Why a tree may not be put at `path`, given this machine's `home` and
 * the broker's `trees`; nothing where it may.
 */
export function placeRefused(
	path: string,
	home: string,
	trees: string,
): string | undefined {
	const at = `Its done file places it at ${path}`;
	const really = asItLeads(path);
	if (really === undefined) {
		return `${at}, through a link that leads nowhere, so where it would go can't be told and it isn't put there.`;
	}
	const broker = asItLeads(trees) ?? trees;
	if (dirname(really) === broker) {
		return hidden(basename(really))
			? `${at}, under a hidden name in the work broker's trees, so it isn't put there.`
			: undefined;
	}
	if (liesIn(really, broker)) {
		return `${at}, inside another of the work broker's trees rather than beside them, so it isn't put there.`;
	}
	const own = asItLeads(home) ?? home;
	const parts = liesIn(really, own) ? relative(own, really).split(sep) : [];
	const root = parts[0];
	if (
		parts.length < 2 ||
		root === undefined ||
		!CHECKOUT_ROOTS.some((one) => one === root)
	) {
		return `${at}, outside the work broker's trees at ${trees} and the folders checkouts go in, ~/src and ~/world, so it isn't put there.`;
	}
	if (parts.some(hidden)) {
		return `${at}, in a hidden folder, where a tree may be read as settings or code to load, so it isn't put there.`;
	}
	const holder = checkoutAbove(join(own, root), parts.slice(1, -1));
	if (holder !== undefined) {
		return `${at}, inside the checkout at ${holder}, where a tree may be read as its settings or code, so it isn't put there.`;
	}
	return undefined;
}

/** Whether a part of a path is hidden by its leading dot. */
function hidden(part: string): boolean {
	return part.startsWith(".");
}

/** Whether `path` lies strictly inside `folder`, both as written. */
function liesIn(path: string, folder: string): boolean {
	const between = relative(folder, path);
	return !(
		between === "" ||
		between === ".." ||
		between.startsWith(`..${sep}`) ||
		isAbsolute(between)
	);
}

/**
 * The first folder below `root`, along `between`, that holds a `.git`
 * and so is a checkout or a tree already; nothing where none does.
 */
function checkoutAbove(
	root: string,
	between: readonly string[],
): string | undefined {
	let folder = root;
	for (const part of between) {
		folder = join(folder, part);
		if (existsSync(join(folder, ".git"))) return folder;
	}
	return undefined;
}

/**
 * `path` past every link in the part of it that stands, the rest as
 * written; nothing where what stands is a link that leads nowhere.
 */
function asItLeads(path: string): string | undefined {
	const rest: string[] = [];
	let at = path;
	while (!stands(at) && dirname(at) !== at) {
		rest.unshift(basename(at));
		at = dirname(at);
	}
	try {
		return join(realpathSync(at), ...rest);
	} catch {
		return undefined;
	}
}

/** Whether anything, a link that leads nowhere included, stands at `path`. */
function stands(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
