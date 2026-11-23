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
 * outlived it, is skipped too. Any other tree that can't go is refused
 * and named, never a reason to carry nothing, since the rest still goes.
 *
 * A session file larger than the largest a mycelium share carries goes
 * gzipped, named with `.gz`, which arriving unzips; any other goes as
 * it is, so a machine whose harness can't unzip still takes it. One
 * still larger once gzipped is refused, saying so, and no done file is
 * written for it.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";
import type { Exec } from "../../core/exec/index.ts";
import { bundleTree, neededFrom } from "../../core/work/carry.ts";
import type { FenceKind } from "../../mesh/presence.ts";
import { patchChanges } from "./changes.ts";
import {
	type HandedTree,
	type Handover,
	withinHome,
	writeHandover,
} from "./handover.ts";
import type { CarriedNote } from "./notes.ts";

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
}

/**
 * The largest file mycelium's share takes from a folder named for
 * sharing, as its `LARGEST_FILE` (src/share/exchange.rs) says: 64 MiB,
 * since the machine it lands on holds each file whole. A long-lived
 * session's log passes it.
 */
export const SHARE_LARGEST_FILE = 64 * 1024 * 1024;

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
	const { exec, into, home, session } = carrying;
	// The file first, so one refused leaves no tree's bundle for the share.
	mkdirSync(into, { recursive: true });
	const sessionFile =
		session.file === undefined
			? undefined
			: await copyBeside(
					session.file,
					into,
					carrying.largestFile ?? SHARE_LARGEST_FILE,
				);
	const trees = await carryTrees(exec, carrying.trees, into, home);
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
	return { file: writeHandover(into, handover), handover, trees };
}

/**
 * Carries each tree at `paths` into `into`, its bundle and patch beside
 * where a done file goes, and says what became of each; writes no done
 * file, which whoever names them writes once they are all in place.
 */
export async function carryTrees(
	exec: Exec,
	paths: readonly string[],
	into: string,
	home: string,
): Promise<TreeCarried[]> {
	mkdirSync(into, { recursive: true });
	const trees: TreeCarried[] = [];
	for (const path of paths) {
		trees.push(await carryTreeAway(exec, path, into, home));
	}
	return trees;
}

/** One tree, carried into `into` or named with why not. */
async function carryTreeAway(
	exec: Exec,
	path: string,
	into: string,
	home: string,
): Promise<TreeCarried> {
	const ask = async (...args: string[]) => {
		const said = await exec("git", ["-C", path, ...args]);
		return said.code === 0 ? said.stdout.trim() : undefined;
	};
	const no = (why: string): TreeCarried => ({ kind: "refused", path, why });
	// A record outlives a tree removed by hand: 16 of 18 refused at once.
	if (!existsSync(path)) {
		return {
			kind: "skipped",
			path,
			why: "It is gone from this machine, so there is nothing of it to carry.",
		};
	}
	if ((await ask("symbolic-ref", "-q", "HEAD")) === undefined) {
		return {
			kind: "skipped",
			path,
			why: "It is on no branch, so it isn't carried: a snapshot is cut again there when it is wanted, and anything changed in it stays here.",
		};
	}
	const origin = await ask("config", "--get", "remote.origin.url");
	if (origin === undefined) {
		return no(
			"It has no origin, so the other machine has nowhere to clone it from.",
		);
	}
	const name = nameFor(path);
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
	};
	return { kind: "carried", path, tree };
}

/**
 * What a tree's files are named in the handover: its folder's name, for
 * a person reading the folder, and a short hash of its whole path, so two
 * trees of one name never share one.
 */
function nameFor(path: string): string {
	const readable = basename(path)
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^[.-]+/, "");
	const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
	return `${readable || "tree"}-${hash}`;
}

/**
 * Copies a session's file beside the done file, answering its name
 * there: gzipped when it is larger than `largest`, so the share takes it.
 * The gzip is written in the quest scratch's tmp/, which the share never
 * reads, and renamed in whole, so the share never sees half of it; a
 * gzip still over `largest` is refused, since the share would refuse it
 * too. Each name drops the other form an earlier carry left.
 */
async function copyBeside(
	file: string,
	into: string,
	largest: number,
): Promise<string> {
	const name = basename(file);
	const zipped = `${name}${ZIPPED}`;
	const size = statSync(file).size;
	if (size <= largest) {
		rmSync(join(into, zipped), { force: true });
		copyFileSync(file, join(into, name));
		return name;
	}
	const tmp = join(dirname(dirname(into)), "tmp");
	mkdirSync(tmp, { recursive: true });
	const staging = mkdtempSync(join(tmp, "carrying-"));
	try {
		const staged = join(staging, zipped);
		await pipeline(
			createReadStream(file),
			createGzip({ level: constants.Z_BEST_COMPRESSION }),
			createWriteStream(staged),
		);
		const gzipped = statSync(staged).size;
		if (gzipped > largest) {
			throw new Error(
				`its file ${name} is ${mib(size)} MiB, and ${mib(gzipped)} MiB gzipped, still over the ${mib(largest)} MiB the share carries, so it stays here until the share takes larger files`,
			);
		}
		renameSync(staged, join(into, zipped));
		rmSync(join(into, name), { force: true });
		return zipped;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** `bytes` in MiB, to one place. */
function mib(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}
