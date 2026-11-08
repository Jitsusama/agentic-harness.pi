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
 * committed. One on no branch is carried only when there is nothing to
 * carry, a snapshot of a commit a remote has, which the other machine
 * cuts again if it wants one; any other is refused and named, never a
 * reason to carry nothing, since the rest of the work still goes.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { bundleTree, neededFrom } from "../../core/work/carry.ts";
import { patchChanges } from "./changes.ts";
import {
	type HandedTree,
	type Handover,
	withinHome,
	writeHandover,
} from "./handover.ts";

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
}

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
	const trees = await carryTrees(exec, carrying.trees, into, home);
	const sessionFile =
		session.file === undefined ? undefined : copyBeside(session.file, into);
	const handover: Handover = {
		session: session.id,
		quest: carrying.quest,
		cwd: withinHome(session.cwd, home),
		...(session.title ? { title: session.title } : {}),
		...(sessionFile === undefined ? {} : { sessionFile }),
		trees: trees.flatMap((one) => (one.kind === "carried" ? [one.tree] : [])),
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
	if ((await ask("symbolic-ref", "-q", "HEAD")) === undefined) {
		return (await isPlainSnapshot(ask))
			? {
					kind: "skipped",
					path,
					why: "It is on no branch, at a commit a remote has, with nothing changed: there is nothing to carry.",
				}
			: no(
					"It is on no branch, so its commits or changes would have nowhere to go there. Make one with a branch action first.",
				);
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

/** Whether a tree on no branch is clean, at a commit a remote has. */
async function isPlainSnapshot(
	ask: (...args: string[]) => Promise<string | undefined>,
): Promise<boolean> {
	const changed = await ask("status", "--porcelain", "--untracked-files=all");
	if (changed !== "") return false;
	const held = await ask("branch", "--remotes", "--contains", "HEAD");
	return held !== undefined && held !== "";
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

/** Copies a session's file beside the done file, answering its name there. */
function copyBeside(file: string, into: string): string {
	const name = basename(file);
	copyFileSync(file, join(into, name));
	return name;
}
