/**
 * A handover: what a session, or `pi-carry` for what no session runs,
 * put in its quest's scratch for another machine to take up, and the
 * done file that says so.
 *
 * Each goes in `handover/<this machine>/` in the quest's scratch folder,
 * which mycelium's share carries to the machine the quest goes to. The
 * done file, `<session id>.done.json` (or `<quest>.done.json` for trees
 * no session held), is written last and whole, once every bundle, patch
 * and session file it names is in place, so whoever sees it can trust
 * what it lists is there. Paths in it are within home (`~/src/...`),
 * since the other machine's home is elsewhere (/home/joel here is
 * /Users/joel on a Mac).
 *
 * Read on the other machine, a done file is trusted for nothing: every
 * field is checked before git or the disk is given it.
 */

import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Needed } from "../../core/work/carry.ts";
import type { FenceKind } from "../../mesh/presence.ts";
import { writeWhole } from "../write-whole.ts";
import { isFenceKind } from "./fence.ts";
import { type CarriedNote, isCarriedNote } from "./notes.ts";
import { isSparse, type Sparse } from "./sparse.ts";

/** The folder of a quest's scratch a handover is put in. */
export const HANDOVER = "handover";

/** One tree in a handover, as the other machine takes it up. */
export interface HandedTree {
	/** Where it is, within home: `~/src/...`. */
	readonly path: string;
	/**
	 * Where its origin is, which the other machine clones or fetches. Read
	 * whatever it says; arrival refuses only this tree where it begins
	 * with a dash, or a part of its branch or a need's does, as
	 * {@link flagIn} tells it, so git is never given one.
	 */
	readonly origin: string;
	/** The branch it was on. */
	readonly branch: string;
	/** The commit the branch stood at. */
	readonly head: string;
	/** The bundle of commits no remote has, beside the done file; absent when a remote has them all. */
	readonly bundle?: string;
	/** What the bundle leaves out because a remote held it, and the remote branch each was on. */
	readonly needs: readonly Needed[];
	/** Its uncommitted changes, untracked files included, beside the done file; absent when it was clean. */
	readonly patch?: string;
	/** The sparse checkout it stood in; absent when it had none, or an older harness carried it. */
	readonly sparse?: Sparse;
}

/** A done file: a session's work, carried. */
export interface Handover {
	/** The session's id, or the quest's for trees no session held. */
	readonly session: string;
	/** The quest it is carried for. */
	readonly quest: string;
	/** The folder it ran in, within home. */
	readonly cwd: string;
	/** Its window's title, if it had one. */
	readonly title?: string;
	/** Its file, beside the done file; absent for trees no session held. */
	readonly sessionFile?: string;
	/** Each tree it held. */
	readonly trees: readonly HandedTree[];
	/** The fence its commands ran under, which it arrives under; absent from older harnesses. */
	readonly fence?: FenceKind;
	/** Its quest's remembered facts; absent from older harnesses and from trees no session held. */
	readonly notes?: readonly CarriedNote[];
}

const DONE = ".done.json";

/** A name git or a share may be handed as it stands: no path, no flag. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A commit's name as git prints it whole. */
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Where the machine `machine` puts its handovers of `quest`. */
export function handoverOf(
	workspaces: string,
	quest: string,
	machine: string,
): string {
	return join(workspaces, quest, HANDOVER, machine);
}

/** The done file named for `name` (a session's id, or the quest's) in `dir`. */
export function doneFileOf(dir: string, name: string): string {
	return join(dir, `${name}${DONE}`);
}

/** The names of the done files in a handover folder's listing. */
export function doneNames(listing: readonly string[]): string[] {
	return listing
		.filter((name) => name.endsWith(DONE))
		.map((name) => name.slice(0, -DONE.length));
}

/** Writes `handover` as its done file in `dir`, whole, answering its path. */
export function writeHandover(dir: string, handover: Handover): string {
	const file = doneFileOf(dir, handover.session);
	writeWhole(file, `${JSON.stringify(handover, null, 2)}\n`);
	return file;
}

/** The done file at `file`, or undefined when it isn't there or doesn't hold up. */
export function readHandover(file: string): Handover | undefined {
	let said: unknown;
	try {
		said = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// Not there yet, or not a done file: either way nothing to take up.
		return undefined;
	}
	return isHandover(said) ? said : undefined;
}

/** `path` as it is within `home` (`~/src/x`), or as it stands outside it. */
export function withinHome(path: string, home: string): string {
	const inside = relative(home, path);
	if (inside === "") return "~";
	if (inside.startsWith("..") || isAbsolute(inside)) return path;
	return `~/${inside.split(sep).join("/")}`;
}

/** A path within home (`~/src/x`) made whole under `home`. */
export function underHome(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function isHandover(value: unknown): value is Handover {
	if (typeof value !== "object" || value === null) return false;
	const said = value as Record<string, unknown>;
	return (
		isPlain(said.session) &&
		isPlain(said.quest) &&
		isPlace(said.cwd) &&
		(said.title === undefined || typeof said.title === "string") &&
		(said.sessionFile === undefined || isPlain(said.sessionFile)) &&
		Array.isArray(said.trees) &&
		said.trees.every(isHandedTree) &&
		(said.fence === undefined || isFenceKind(said.fence)) &&
		(said.notes === undefined ||
			(Array.isArray(said.notes) && said.notes.every(isCarriedNote)))
	);
}

function isHandedTree(value: unknown): value is HandedTree {
	if (typeof value !== "object" || value === null) return false;
	const tree = value as Record<string, unknown>;
	return (
		isPlace(tree.path) &&
		typeof tree.origin === "string" &&
		tree.origin !== "" &&
		isBranch(tree.branch) &&
		typeof tree.head === "string" &&
		COMMIT.test(tree.head) &&
		(tree.bundle === undefined || isPlain(tree.bundle)) &&
		(tree.patch === undefined || isPlain(tree.patch)) &&
		(tree.sparse === undefined || isSparse(tree.sparse)) &&
		Array.isArray(tree.needs) &&
		tree.needs.every(isNeeded)
	);
}

function isNeeded(value: unknown): value is Needed {
	if (typeof value !== "object" || value === null) return false;
	const need = value as Record<string, unknown>;
	return (
		typeof need.commit === "string" &&
		COMMIT.test(need.commit) &&
		(need.on === undefined || isBranch(need.on))
	);
}

/** A file's name beside the done file, which reaches nowhere else. */
function isPlain(value: unknown): value is string {
	return (
		typeof value === "string" &&
		PLAIN_NAME.test(value) &&
		value === basename(value)
	);
}

/** A folder within home, or a whole path, never climbing out of where it names. */
function isPlace(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value !== "~" && !value.startsWith("~/") && !value.startsWith("/")) {
		return false;
	}
	return !value.split("/").includes("..");
}

/** A branch's name, as git could take it, climbing nowhere. */
function isBranch(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value !== "" &&
		!value.split("/").includes("..") &&
		!/[\s~^:?*[\\]/.test(value)
	);
}

/**
 * The name in `tree` a git command could read as a flag, or none: its
 * origin, or its branch or a remote branch it needs with any part
 * starting with `-`, since a remote branch's `<remote>/<branch>` reaches
 * git as two arguments. Only that tree is refused for it, so the rest
 * of its done file still arrives.
 */
export function flagIn(tree: HandedTree): string | undefined {
	const flagLike = (name: string) =>
		name.split("/").some((part) => part.startsWith("-"));
	if (tree.origin.startsWith("-")) return tree.origin;
	if (flagLike(tree.branch)) return tree.branch;
	return tree.needs.find((need) => need.on !== undefined && flagLike(need.on))
		?.on;
}
