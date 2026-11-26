/**
 * Carrying a session's work away: each tree it holds, then its own file,
 * then the done file saying what was carried, into its quest's handover.
 *
 * Both ends of a carry come here: a session told to carry (the steer act,
 * mesh-workflow's carrying.ts), and `pi-carry` for the sessions no pi
 * runs and the trees no session holds (rest.ts).
 *
 * A tree goes as its origin, its branch and the commit it stood at, with
 * a bundle of the commits no remote has and a patch of what was never
 * committed. One on no branch is skipped and named, its files left where
 * they are on this machine: a snapshot is cut again there when it is
 * wanted. Refusing them closed live sessions and failed whole carries on
 * 23 November, for 2, 11 and 87 such trees, and judging each one clean
 * took seconds a tree in World. One gone from this machine, whose record
 * outlived it, is skipped too; one that can't be read, or that git can't
 * read as a tree, is refused. Any other tree that can't go is refused
 * and named, and the rest still goes, unless the carry is asked to go
 * whole: a session carrying itself is, since the node closes it once its
 * done file is written, and a tree left behind would lose its session.
 *
 * A session file larger than the largest a mycelium share carries goes
 * gzipped, named with `.gz`, which arriving unzips; any other goes as
 * it is, so a machine whose harness can't unzip still takes it. One
 * still larger once gzipped is refused, saying so, and no done file is
 * written for it.
 *
 * Everything a carry writes is staged in the quest scratch's tmp/, which
 * the share never reads, and renamed into the handover only once the
 * carry stands: the share sends what it finds there at once, so a carry
 * refused after writing a tree's patch would have sent that tree's
 * uncommitted work anyway, and one session carrying again would have
 * written over the bundle its own done file still names. What a placed
 * file replaces waits in the staging folder until the done file is
 * written, and goes back where that fails (stage.ts).
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	createWriteStream,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";
import type { Exec } from "../../core/exec/index.ts";
import { bundleTree, neededFrom } from "../../core/work/carry.ts";
import type { FenceKind } from "../../mesh/presence.ts";
import { patchChanges } from "./changes.ts";
import {
	doneFileOf,
	type HandedTree,
	type Handover,
	readHandover,
	SHARE_LARGEST_FILE,
	underHome,
	withinHome,
	writeHandover,
} from "./handover.ts";
import { messageOf } from "./message.ts";
import type { CarriedNote } from "./notes.ts";
import { sparseOf } from "./sparse.ts";
import { handoverMade, type Stage, staged } from "./stage.ts";

/** What is carried, and where. */
export interface Carrying {
	readonly exec: Exec;
	/** The handover folder: `handover/<this machine>/` in the quest's scratch. */
	readonly into: string;
	/** This machine's home, which paths are written within. */
	readonly home: string;
	readonly quest: string;
	/** The session, or for trees no session held, the quest under its own id. */
	readonly session: {
		readonly id: string;
		readonly cwd: string;
		readonly title?: string;
		/** Its file; none for trees no session held. */
		readonly file?: string;
	};
	/** The trees it holds, by their folders here. */
	readonly trees: readonly string[];
	/** The fence its commands ran under; unknown for sessions no pi runs. */
	readonly fence?: FenceKind;
	/** Its quest's remembered facts. */
	readonly notes?: readonly CarriedNote[];
	/** The largest session file that goes as it is; `SHARE_LARGEST_FILE` unless a test names one. */
	readonly largestFile?: number;
	/**
	 * Carry all or nothing: when any tree is refused, put nothing in the
	 * handover and throw naming each, so the session stays where it is
	 * with all its work. A session carrying itself asks this; `pi-carry`
	 * carries what it can.
	 */
	readonly whole?: boolean;
}

/** A carry asked to go whole that a refused tree kept here. */
export class CarryNotWhole extends Error {
	readonly trees: readonly TreeCarried[];

	constructor(trees: readonly TreeCarried[]) {
		const refused = trees.flatMap((one) =>
			one.kind === "refused" ? [`${one.path}: ${one.why}`] : [],
		);
		super(
			`${refused.length === 1 ? "a tree" : `${refused.length} trees`} can't go, so nothing was carried:\n${refused.join("\n")}`,
		);
		this.name = "CarryNotWhole";
		this.trees = trees;
	}
}

/** What a gzipped session file's name ends in. */
export const ZIPPED = ".gz";

/** What became of one tree. */
export type TreeCarried =
	| {
			readonly kind: "carried";
			readonly path: string;
			readonly tree: HandedTree;
	  }
	| { readonly kind: "skipped"; readonly path: string; readonly why: string }
	| { readonly kind: "refused"; readonly path: string; readonly why: string };

/** What carrying a session away did: its done file, and each tree. */
export interface CarriedAway {
	readonly file: string;
	readonly handover: Handover;
	readonly trees: readonly TreeCarried[];
}

/**
 * Carries the session's trees and file into its handover folder, and
 * writes its done file last.
 */
export async function carryAway(carrying: Carrying): Promise<CarriedAway> {
	handoverMade(carrying.into);
	return staged(carrying.into, carrying.session.id, (stage) =>
		carryAll(carrying, stage),
	);
}

/**
 * carryAway's work, staged in `stage`, throwing CarryNotWhole when a
 * whole carry can't go.
 */
async function carryAll(
	carrying: Carrying,
	stage: Stage,
): Promise<CarriedAway> {
	const { exec, into, home, session } = carrying;
	// The file first, so one refused takes no tree's time.
	const largest = carrying.largestFile ?? SHARE_LARGEST_FILE;
	const sessionFile =
		session.file === undefined
			? undefined
			: await copyBeside(session.file, stage.folder, largest);
	const trees = await stageTrees(
		exec,
		carrying.trees,
		stage.folder,
		home,
		session.id,
		largest,
	);
	if (carrying.whole && trees.some((one) => one.kind === "refused")) {
		throw new CarryNotWhole(trees);
	}
	// An earlier done file of this session goes aside first, so the share
	// never finds it naming a bundle this carry replaced, and with it
	// what it names, so none this carry doesn't name again is left behind.
	stage.place(filesOf(trees), earlierOf(into, home, session.id));
	if (sessionFile !== undefined) {
		// Each form drops the other an earlier carry left.
		stage.place(
			[sessionFile],
			[
				sessionFile.endsWith(ZIPPED)
					? sessionFile.slice(0, -ZIPPED.length)
					: `${sessionFile}${ZIPPED}`,
			],
		);
	}
	const handover: Handover = {
		session: session.id,
		quest: carrying.quest,
		cwd: withinHome(session.cwd, home),
		...(session.title ? { title: session.title } : {}),
		...(sessionFile === undefined ? {} : { sessionFile }),
		trees: trees.flatMap((one) => (one.kind === "carried" ? [one.tree] : [])),
		...(carrying.fence === undefined ? {} : { fence: carrying.fence }),
		...(carrying.notes === undefined || carrying.notes.length === 0
			? {}
			: { notes: carrying.notes }),
	};
	return {
		file: stage.placeLast((folder) => writeHandover(folder, handover)),
		handover,
		trees,
	};
}

/**
 * The done file of `owner`'s earlier carry into `into`, if any, and
 * each file it names there that such a carry writes: its session file,
 * and each tree's bundle and patch under that tree's name for `owner`.
 * Any other name it holds is left alone, since the files it would move
 * aside, and so delete, could be another carry's.
 */
function earlierOf(into: string, home: string, owner: string): string[] {
	const done = doneFileOf(into, owner);
	const earlier = readHandover(done);
	const file = earlier?.sessionFile;
	return [
		basename(done),
		...(file !== undefined && plain(file) && /\.jsonl(\.gz)?$/.test(file)
			? [file]
			: []),
		...(earlier?.trees ?? []).flatMap((tree) => {
			const name = nameFor(underHome(tree.path, home), owner);
			return [`${name}.bundle`, `${name}.patch`].filter(
				(own) => own === tree.bundle || own === tree.patch,
			);
		}),
	];
}

/** Whether `name` is a plain file name, holding no folder. */
function plain(name: string): boolean {
	return name !== "" && name === basename(name) && !name.startsWith(".");
}

/** The bundles and patches of the trees carried. */
function filesOf(trees: readonly TreeCarried[]): string[] {
	return trees.flatMap((one) =>
		one.kind === "carried"
			? [one.tree.bundle, one.tree.patch].filter(
					(name): name is string => name !== undefined,
				)
			: [],
	);
}

/**
 * A carried tree whose bundle or patch the share would refuse, refused
 * here instead, with both taken out of the staging folder `into`, so
 * nothing closes for a carry the share then fails.
 */
function withinShare(
	one: TreeCarried,
	into: string,
	largest: number,
): TreeCarried {
	if (one.kind !== "carried") return one;
	for (const name of [one.tree.bundle, one.tree.patch]) {
		if (name === undefined) continue;
		const size = statSync(join(into, name)).size;
		if (size > largest) {
			for (const left of [one.tree.bundle, one.tree.patch]) {
				if (left !== undefined) rmSync(join(into, left), { force: true });
			}
			return {
				kind: "refused",
				path: one.path,
				why: `Its ${name} is ${sized(size)}, over the ${sized(largest)} the share carries.`,
			};
		}
	}
	return one;
}

/** What carrying a quest's own trees did: each tree, and its done file. */
export interface QuestTreesCarried {
	readonly trees: readonly TreeCarried[];
	readonly file?: string;
}

/**
 * Carries each tree at `paths` into `into` under `quest`'s own done
 * file, says what became of each, and writes that done file last, as a
 * session's carry does: the quest's earlier done file and what it names
 * go aside first, and come back where writing fails. Where no tree goes,
 * no done file is written, since one of no trees and no session would
 * start nothing there, and the earlier one goes with what it names: it
 * would name trees this carry skipped or left to a session's own carry,
 * which would then arrive twice. Where any tree is refused, though, the
 * carry isn't whole and nothing is placed: the earlier one stays as it
 * was, so a passing error never takes the last good carry with it, and
 * no tree after it is staged: each other tree is answered as held back
 * with it, since its bundle goes with the staging. A bundle or patch
 * larger than `largest` refuses its tree, since the share would refuse
 * it.
 */
export async function carryQuestTrees(
	exec: Exec,
	paths: readonly string[],
	into: string,
	home: string,
	quest: string,
	largest = SHARE_LARGEST_FILE,
): Promise<QuestTreesCarried> {
	handoverMade(into);
	return staged(into, quest, async (stage) => {
		const trees = await stageTrees(
			exec,
			paths,
			stage.folder,
			home,
			quest,
			largest,
			true,
		);
		const refused = trees.find((one) => one.kind === "refused");
		if (refused !== undefined) {
			return { trees: heldBackWith(refused.path, paths, trees) };
		}
		const handed = trees.flatMap((one) =>
			one.kind === "carried" ? [one.tree] : [],
		);
		stage.place(filesOf(trees), earlierOf(into, home, quest));
		if (handed.length === 0) return { trees };
		const file = stage.placeLast((folder) =>
			writeHandover(folder, {
				session: quest,
				quest,
				cwd: "~",
				trees: handed,
			}),
		);
		return { trees, file };
	});
}

/** Each tree at `paths` carried into the staging folder `stage`. */
async function stageTrees(
	exec: Exec,
	paths: readonly string[],
	stage: string,
	home: string,
	owner: string,
	largest: number,
	untilRefused = false,
): Promise<TreeCarried[]> {
	const trees: TreeCarried[] = [];
	for (const path of paths) {
		const one = await carryTreeAway(exec, path, stage, home, owner);
		const within = withinShare(one, stage, largest);
		trees.push(within);
		if (untilRefused && within.kind === "refused") break;
	}
	return trees;
}

/**
 * Each of `paths` as a quest's carry refused for `refused` answers it:
 * that one with its own why, one skipped (gone, or on no branch) with
 * its own, since it would never have gone, and every other held back
 * with it, whether it was staged or not yet tried.
 */
function heldBackWith(
	refused: string,
	paths: readonly string[],
	staged: readonly TreeCarried[],
): TreeCarried[] {
	return paths.map(
		(path) =>
			staged.find((one) => one.kind !== "carried" && one.path === path) ?? {
				kind: "refused",
				path,
				why: `held back, since ${refused} was refused and a quest's own trees go together; its earlier carry stays as it was`,
			},
	);
}

/**
 * Whether `path` is there, gone (nothing at it, or a file where a folder
 * on its way should be), or can't be told, saying why.
 */
function standing(
	path: string,
):
	| { readonly kind: "there" | "gone" }
	| { readonly kind: "unread"; readonly why: string } {
	try {
		return {
			kind:
				statSync(path, { throwIfNoEntry: false }) === undefined
					? "gone"
					: "there",
		};
	} catch (error) {
		return {
			kind: "unread",
			why: messageOf(error),
		};
	}
}

/** One tree, carried into `into` or named with why not. */
async function carryTreeAway(
	exec: Exec,
	path: string,
	into: string,
	home: string,
	owner: string,
): Promise<TreeCarried> {
	const ask = async (...args: string[]) => {
		const said = await exec("git", ["-C", path, ...args]);
		return said.code === 0 ? said.stdout.trim() : undefined;
	};
	const no = (why: string): TreeCarried => ({ kind: "refused", path, why });
	// A record outlives a tree removed by hand: 16 of 18 refused at once.
	// Only a path that isn't there is gone; one that can't be told is refused.
	const stood = standing(path);
	if (stood.kind === "gone") {
		return {
			kind: "skipped",
			path,
			why: "It is gone from this machine, so there is nothing of it to carry.",
		};
	}
	if (stood.kind === "unread") {
		return no(`It can't be read here: ${stood.why}`);
	}
	// git -C walks up, so a folder inside another tree would be read as
	// that tree; and a git that never started answers nothing at all.
	const top = await ask("rev-parse", "--show-toplevel");
	if (top === undefined) {
		return no("git couldn't read it as a tree.");
	}
	if (realpathSync(top) !== realpathSync(path)) {
		return no(`It lies inside another tree, ${top}, not a tree of its own.`);
	}
	// symbolic-ref says 1 for a HEAD on no branch, but a spawn error or a
	// signal reads as 1 too, so a detached HEAD is confirmed by its commit.
	const branch = await exec("git", ["-C", path, "symbolic-ref", "-q", "HEAD"]);
	if (
		branch.code === 1 &&
		(await ask("rev-parse", "--verify", "-q", "HEAD")) !== undefined
	) {
		return {
			kind: "skipped",
			path,
			why: "It is on no branch, so it isn't carried: a snapshot is cut again there when it is wanted, and anything changed in it stays here.",
		};
	}
	if (branch.code !== 0) {
		return no(
			`git couldn't read its branch: ${branch.stderr.trim() || `it exited ${branch.code}`}`,
		);
	}
	const origin = await ask("config", "--get", "remote.origin.url");
	if (origin === undefined) {
		return no(
			"It has no origin, so the other machine has nowhere to clone it from.",
		);
	}
	// Before anything is written, so a refused tree leaves nothing behind.
	const sparse = await sparseOf(ask);
	if (sparse !== undefined && "why" in sparse) return no(sparse.why);
	const name = nameFor(path, owner);
	const bundled = await bundleTree(exec, path, into, name);
	if (bundled.kind === "refused") return no(bundled.reason);
	const head =
		bundled.kind === "bundled"
			? bundled.carried.head
			: await ask("rev-parse", "HEAD");
	if (head === undefined) return no("git couldn't say what HEAD is.");
	const patched = await patchChanges(exec, path, into, name);
	if (patched.kind === "refused") return no(patched.reason);
	const tree: HandedTree = {
		path: withinHome(path, home),
		origin,
		branch:
			bundled.kind === "bundled" ? bundled.carried.branch : bundled.branch,
		head,
		...(bundled.kind === "bundled" ? { bundle: bundled.carried.bundle } : {}),
		// With nothing to bundle, the head itself is what a remote holds.
		needs:
			bundled.kind === "bundled"
				? bundled.carried.needs
				: [await neededFrom(exec, path, head)],
		...(patched.kind === "patched" ? { patch: patched.patch } : {}),
		...(sparse === undefined ? {} : { sparse }),
	};
	return { kind: "carried", path, tree };
}

/**
 * What a tree's files are named in the handover: its folder's name, for
 * a person reading the folder, and a short hash of its whole path and
 * its `owner`, the session or quest whose done file names them. So two
 * trees of one name never share one, and nor do two sessions of one
 * quest carrying one tree: the handover is the quest's, and a carry
 * writing over another session's bundle would leave that session's done
 * file naming bytes it never carried. The hash is 64 bits, since a
 * clash would put one tree's bundle under another's name and nothing
 * checks for one.
 */
export function nameFor(path: string, owner: string): string {
	const readable = basename(path)
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^[.-]+/, "");
	const hash = createHash("sha256")
		.update(`${owner}\0${path}`)
		.digest("hex")
		.slice(0, 16);
	return `${readable || "tree"}-${hash}`;
}

/**
 * Copies a session's file into the staging folder `stage`, answering its
 * name there: gzipped when it is larger than `largest`, so the share
 * takes it, and gzipped too when it grew past `largest` while copied. A
 * gzip still over `largest` is refused, since the share would refuse it
 * too.
 */
async function copyBeside(
	file: string,
	stage: string,
	largest: number,
): Promise<string> {
	const name = basename(file);
	const size = statSync(file).size;
	if (size <= largest) {
		copyFileSync(file, join(stage, name));
		if (statSync(join(stage, name)).size <= largest) return name;
		// It grew while copied: no copy over what the share takes stays.
		rmSync(join(stage, name), { force: true });
	}
	const zipped = `${name}${ZIPPED}`;
	await pipeline(
		createReadStream(file),
		createGzip({ level: constants.Z_BEST_COMPRESSION }),
		createWriteStream(join(stage, zipped)),
	);
	const gzipped = statSync(join(stage, zipped)).size;
	if (gzipped > largest) {
		throw new Error(
			`its file ${name} is ${mib(size)} MiB, and ${mib(gzipped)} MiB gzipped, still over the ${mib(largest)} MiB the share carries, so it stays here until the share takes larger files`,
		);
	}
	return zipped;
}

/** `bytes` in MiB, to one place. */
function mib(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

/** `bytes` in MiB, or in bytes when under one. */
function sized(bytes: number): string {
	return bytes < 1024 * 1024 ? `${bytes} bytes` : `${mib(bytes)} MiB`;
}
