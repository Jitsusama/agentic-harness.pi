/**
 * Trees standing where the broker cuts them that nothing can use.
 *
 * A tree is found again by its folder's name, so one the broker's
 * record forgot is handed over the next time somebody asks for it, as
 * long as git will read it. One git won't run in can be neither handed
 * over, released nor cut again, and no checkout's survey lists it: on
 * 20 November a council killed by a host restart left a snapshot cut
 * from a clone outside ~/src, whose settings the fence doesn't guard,
 * and every snapshot of that commit then failed on git's "already
 * exists".
 *
 * Such a tree is set aside whole rather than removed, since git can't
 * be asked whether it holds uncommitted work: moving it frees its name
 * and keeps every file it held.
 */

import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolvedPath } from "./in-use.ts";
import { goneGitDir } from "./sweep-orphan.ts";

/** A tree nothing can use, and why git can't read it. */
export interface StrandedTree {
	path: string;
	why: string;
}

/** A tree that looks stranded but stays, and why. */
export interface KeptTree {
	path: string;
	why: string;
}

/** What is known when asking which trees are stranded. */
export interface StrandedAsk {
	/** The folder the broker cuts its trees in. */
	dir: string;
	/**
	 * Every path something live holds, a running session's record, a
	 * claim or a checkout's git, with its links resolved. None of these
	 * is stranded, whatever git says of it: each has an owner who takes
	 * it down. A record whose sessions have all ended is no such hold.
	 */
	kept: ReadonlySet<string>;
	/** Why git won't run in the tree at a path, or nothing when it will. */
	refusal: (path: string) => string | undefined;
}

/** What the sweep names a tree it has moved aside to remove. */
const GOING = ".going-";

/**
 * How long after its `.git` file is written a tree is left alone. A cut
 * writes that file first and its record last, after checking out every
 * file, and a World checkout takes minutes; ten covers the slowest seen.
 */
export const CUT_GRACE_MS = 10 * 60 * 1000;

/**
 * The trees in the folder the broker cuts them in that nothing live
 * holds and git won't read: one whose git folder is gone, or one git is
 * refused in. A folder with no `.git` file is no worktree, so whatever
 * put it there judges it.
 */
export function strandedTrees(ask: StrandedAsk): StrandedTree[] {
	let names: string[];
	try {
		names = readdirSync(ask.dir);
	} catch {
		// No folder yet means no tree was ever cut, so none is stranded.
		return [];
	}
	const stranded: StrandedTree[] = [];
	for (const name of names.sort()) {
		if (name.includes(GOING)) continue;
		const path = join(ask.dir, name);
		if (!isFolder(path) || ask.kept.has(resolvedPath(path))) continue;
		if (!looksCut(path)) continue;
		const why = strandedWhy(path, ask.refusal);
		if (why !== undefined) stranded.push({ path, why: plainWords(why) });
	}
	return stranded;
}

/**
 * Why git can't read the worktree at `path`, or nothing when it can:
 * its git folder is gone, or `refusal` says why git won't run there.
 */
export function strandedWhy(
	path: string,
	refusal: (path: string) => string | undefined,
): string | undefined {
	const gone = goneGitDir(path);
	return gone === undefined
		? refusal(path)
		: `the git folder its .git names, ${gone}, is gone`;
}

/** What tells a stranded tree is still being made or used. */
export interface StrandedSigns {
	/**
	 * Which of `paths`, each a real path, a process works in or holds a
	 * file open in. Nothing when the machine can't say, and then every
	 * tree is kept.
	 */
	busyAmong?(
		paths: readonly string[],
	): Promise<ReadonlySet<string> | undefined>;
	/** Now, in milliseconds since the epoch. */
	now?: number;
}

/** Stranded trees split into those reclaim may set aside and those kept. */
export interface StrandedSplit {
	free: StrandedTree[];
	kept: KeptTree[];
}

/**
 * Split stranded trees into those nothing is making or using, which
 * may be set aside, and those kept for now, each saying why: one git
 * marks locked, as it does while a cut runs; one cut within
 * {@link CUT_GRACE_MS}, whose record may not be written yet; and one
 * a process works in, or every one when the machine can't say.
 */
export async function splitStranded(
	trees: readonly StrandedTree[],
	signs: StrandedSigns,
): Promise<StrandedSplit> {
	const now = signs.now ?? Date.now();
	const kept: KeptTree[] = [];
	const quiet: StrandedTree[] = [];
	for (const tree of trees) {
		const why = makingWhy(tree.path, now);
		if (why === undefined) quiet.push(tree);
		else kept.push({ path: tree.path, why });
	}
	if (quiet.length === 0) return { free: [], kept };
	const busy = await signs.busyAmong?.(
		quiet.map((tree) => resolvedPath(tree.path)),
	);
	if (busy === undefined) {
		return {
			free: [],
			kept: [
				...kept,
				...quiet.map((tree) => ({ path: tree.path, why: CANT_SAY })),
			],
		};
	}
	return {
		free: quiet.filter((tree) => !busy.has(resolvedPath(tree.path))),
		kept: [
			...kept,
			...quiet
				.filter((tree) => busy.has(resolvedPath(tree.path)))
				.map((tree) => ({ path: tree.path, why: WORKED_IN })),
		],
	};
}

/** Why a stranded tree a process works in stays. */
export const WORKED_IN =
	"git won't read it, but something works in it, so it stays for now";

/** Why a stranded tree stays where the machine can't say what works in it. */
export const CANT_SAY =
	"git won't read it, but this machine can't say whether something works in it, so it stays";

/**
 * Why a tree may still be being cut, or nothing: git marks a worktree
 * locked while `worktree add` fills it, and a cut writes its record
 * only once it ends.
 */
function makingWhy(path: string, now: number): string | undefined {
	const gitDir = namedGitDir(path);
	if (gitDir !== undefined && existsSync(join(gitDir, "locked"))) {
		return "git won't read it, but git marks it locked, as it does while a cut runs, so it stays";
	}
	try {
		if (now - statSync(join(path, ".git")).mtimeMs < CUT_GRACE_MS) {
			return "git won't read it, but it was cut in the last ten minutes and its cut may not have ended, so it stays";
		}
	} catch {
		// Its `.git` went since it was listed: the move finds it gone.
	}
	return undefined;
}

/** The git folder a worktree's `.git` file names, or nothing. */
function namedGitDir(path: string): string | undefined {
	try {
		const said = /^gitdir: (.+)$/m.exec(
			readFileSync(join(path, ".git"), "utf8"),
		)?.[1];
		return said === undefined ? undefined : resolve(path, said.trim());
	} catch {
		// No `.git` file to read: nothing names a git folder.
		return undefined;
	}
}

/** What became of one stranded tree. */
export type SetAsideTree =
	| { kind: "set-aside"; path: string; aside: string }
	| { kind: "kept"; path: string; why: string }
	| { kind: "refused"; path: string; why: string };

/** The broker's records, as far as setting a tree aside needs them. */
export interface StrandedRecords {
	/** Every tree a record names. */
	recall(): readonly { path: string }[];
	/**
	 * Run `take` on a recorded tree only while every session its record
	 * names has ended, judged under the record's lock, and forget the
	 * record once it is taken. Answers nothing when `take` didn't run.
	 */
	whileUnheld(path: string, take: () => Promise<boolean>): Promise<unknown>;
}

/** What setting stranded trees aside needs. */
export interface SetAsideDeps {
	/** Where they go: {@link strandedDir}. */
	into: string;
	/** The broker's records, or nothing where there are none. */
	records?: StrandedRecords;
	/**
	 * Why a tree must stay after all, asked just before it moves, or
	 * nothing: what was listed may be seconds old by then.
	 */
	stays?: (path: string) => Promise<string | undefined>;
}

/** Where stranded trees are set aside: beside the trees' folder, never in it. */
export function strandedDir(treesDir: string): string {
	return join(dirname(treesDir), "stranded");
}

/** How many trees wait in `into`, set aside by earlier reclaims. */
export function setAsideEarlier(into: string): number {
	try {
		return readdirSync(into).filter((name) => isFolder(join(into, name)))
			.length;
	} catch {
		// Nothing was ever set aside.
		return 0;
	}
}

/**
 * Move each stranded tree aside whole, under a name of its own in
 * `into`, and say where each went. Each is asked about again just
 * before it moves. One with a record moves only under that record's
 * lock while every session it names has ended, as the sweep takes a
 * tree, and its record goes with it. A move refused leaves the tree
 * where it was and says why, without holding up the rest.
 */
export async function setAside(
	trees: readonly StrandedTree[],
	deps: SetAsideDeps,
): Promise<SetAsideTree[]> {
	const done: SetAsideTree[] = [];
	for (const tree of trees) {
		const stays = await deps.stays?.(tree.path);
		if (stays !== undefined) {
			done.push({ kind: "kept", path: tree.path, why: stays });
			continue;
		}
		const aside = join(
			deps.into,
			`${basename(tree.path)}-${randomBytes(4).toString("hex")}`,
		);
		let refused: string | undefined;
		const move = async () => {
			try {
				mkdirSync(deps.into, { recursive: true });
				renameSync(tree.path, aside);
				return true;
			} catch (error) {
				refused = error instanceof Error ? error.message : String(error);
				return false;
			}
		};
		const real = resolvedPath(tree.path);
		const recorded = deps.records
			?.recall()
			.find((one) => resolvedPath(one.path) === real);
		if (recorded !== undefined && deps.records !== undefined) {
			const took = await deps.records.whileUnheld(recorded.path, move);
			if (took !== undefined) {
				done.push({ kind: "set-aside", path: tree.path, aside });
			} else if (refused !== undefined) {
				done.push({ kind: "refused", path: tree.path, why: refused });
			} else {
				done.push({
					kind: "kept",
					path: tree.path,
					why: "its record names a session that may still hold it, so it stays",
				});
			}
			continue;
		}
		if (await move()) done.push({ kind: "set-aside", path: tree.path, aside });
		else done.push({ kind: "refused", path: tree.path, why: refused ?? "" });
	}
	return done;
}

/** The longest stretch of git's words said back. */
const WORDS_MAX = 400;

/**
 * Words from git or the guard, as one plain line said back: a path in
 * them may be anything a sandboxed command wrote into a `.git` file, so
 * its line breaks and control characters go and a long one is cut.
 */
export function plainWords(said: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: what it removes.
	const flat = said.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return flat.length > WORDS_MAX ? `${flat.slice(0, WORDS_MAX)}...` : flat;
}

/**
 * Whether the folder at `path` is shaped as a cut worktree, its `.git`
 * a file naming a git folder, which is all a stranded tree can be.
 */
export function looksCut(path: string): boolean {
	return isFile(join(path, ".git"));
}

function isFolder(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		// Gone between the listing and now: nothing to judge.
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		// No `.git` here at all.
		return false;
	}
}
