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
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolvedPath } from "./in-use.ts";
import { readPlain } from "./plain-file.ts";
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
 * How long git's `locked` file is taken as a cut still running. A cut
 * killed outright leaves it behind, and one read as running for ever
 * would keep its tree for ever; an hour is six times the slowest cut.
 */
export const LOCK_STALE_MS = 60 * 60 * 1000;

/**
 * Why git won't run in a tree the fence's guard refused, in words of
 * ours: the guard's own name a path a fenced command can choose.
 */
export const GUARD_WORDS =
	"the fence's guard won't run git there, as it can't trust what git would run in that folder";

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
	// The path a `.git` file names is anybody's to write, so it isn't
	// repeated: the file is there to read.
	return goneGitDir(path) === undefined
		? refusal(path)
		: "the git folder its .git file names is gone";
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
 * marks locked, as it does while a cut runs; one locked for a reason
 * other than a cut's English one, which nothing here takes away; one cut within
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
 * Why a stranded tree locked for a reason other than a cut's English
 * one stays, a lock a cut killed before git was told English included: a re-cut
 * never forgets such a lock, so setting the tree aside would leave its
 * name uncuttable. The lock is read where the tree's own `.git` points,
 * which whatever ran in it could have written, so this says what git's
 * files hold rather than who put it there.
 */
export const HAND_LOCKED =
	"git won't read it, but the git entry it names is locked for a reason other than the English one a cut gives, as `git worktree lock` leaves or a cut killed before git here was told English, so it stays until `git worktree unlock`, run from the clone that cut it and never inside it or in a folder its `.git` names, which a sandboxed command could have written, takes that lock away; where that clone doesn't know it, another checkout of the repository may have cut it, or a sandboxed command written the lock, so unlock it from that checkout or move it aside by hand";

/**
 * Why a tree may still be being cut, or must stay where it is, or
 * nothing: git marks a worktree locked while `worktree add` fills it,
 * a cut writes its record only once it ends, and a lock no cut put
 * there is never taken away here.
 */
function makingWhy(path: string, now: number): string | undefined {
	if (handLocked(path)) return HAND_LOCKED;
	if (cutRunning(path, now)) {
		return "git won't read it, but git marks it locked, as it does while a cut runs, so it stays";
	}
	try {
		if (now - statSync(join(path, ".git")).mtimeMs < CUT_GRACE_MS) {
			return "git won't read it, but it was cut in the last ten minutes and its cut may not have ended, so it stays";
		}
	} catch {
		// Its `.git` went since it was listed, which nothing explains as
		// well as somebody at work in it, so it isn't taken as free.
		return "its .git went while it was asked about, so it stays";
	}
	return undefined;
}

/**
 * Whether git marks the worktree at `path` locked within the last
 * {@link LOCK_STALE_MS}, as `worktree add` does while it fills one.
 */
export function cutRunning(path: string, now = Date.now()): boolean {
	const gitDir = namedGitDir(path);
	return (
		gitDir !== undefined && lockedSince(gitDir, now) && !lockedByHand(gitDir)
	);
}

/**
 * Whether the git entry the worktree at `path` names is locked for a
 * reason other than a cut's English one, as `git worktree lock` leaves
 * or a cut killed before git was told English, which nothing
 * here takes away, however old the lock.
 */
export function handLocked(path: string): boolean {
	const gitDir = namedGitDir(path);
	return gitDir !== undefined && lockedByHand(gitDir);
}

/**
 * Part a tree set aside from git's entry for it, keeping its `.git` file
 * as `.git-was` to read. A cut again at its name takes the entry's name
 * back, and a git run in the old folder would then read and write the
 * new tree's index and HEAD.
 */
function unlink(aside: string): void {
	try {
		renameSync(join(aside, ".git"), join(aside, ".git-was"));
	} catch {
		// No `.git` file left to part it from: nothing names an entry.
	}
}

/**
 * Forget git's entry, in the repository whose common folder is
 * `commonDir`, for a worktree at `path` whose folder is gone or empty, as
 * `worktree prune` would but for that one entry alone, so the other
 * entries in that repository stay as they are. One git marks locked
 * stays while its lock is younger than {@link LOCK_STALE_MS}, as a
 * cut may still be running; an older one is a lock a killed cut left,
 * which reclaim sets aside on the same terms. A lock giving a reason
 * other than git's own while it cuts was put there by hand, with
 * `worktree lock`, and is git's to keep. Answers whether one went.
 */
export function forgetGoneEntry(
	commonDir: string,
	path: string,
	now = Date.now(),
): boolean {
	// An empty folder is as gone to git, and is what the cut makes first
	// where each tree is a subvolume of its own.
	if (holdsSomething(path)) return false;
	const entries = join(commonDir, "worktrees");
	// git writes the real path, which only the folder's parent still has.
	const wanted = new Set([
		resolve(path, ".git"),
		join(resolvedPath(dirname(path)), basename(path), ".git"),
	]);
	let names: string[];
	try {
		names = readdirSync(entries);
	} catch {
		// No worktrees folder: git has no entry to forget.
		return false;
	}
	for (const name of names) {
		const entry = join(entries, name);
		try {
			if (!lstatSync(entry).isDirectory()) continue;
			const named = readPlain(join(entry, "gitdir"))?.trim();
			if (named === undefined || !wanted.has(resolve(entry, named))) continue;
			if (lockedSince(entry, now) || lockedByHand(entry)) return false;
			rmSync(entry, { recursive: true, force: true });
			return true;
		} catch {
			// An entry git can't have written, or one going as it is read.
		}
	}
	return false;
}

/**
 * Whether git's entry `entry` is locked for a reason of somebody's own
 * rather than the word `worktree add` writes while it fills a tree.
 */
function lockedByHand(entry: string): boolean {
	const reason = readPlain(join(entry, "locked"));
	return reason !== undefined && reason.trim() !== "initializing";
}

/** Whether anything stands at `path` other than an empty folder. */
function holdsSomething(path: string): boolean {
	try {
		return !lstatSync(path).isDirectory() || readdirSync(path).length > 0;
	} catch {
		// Nothing there at all.
		return false;
	}
}

/** Whether git's entry `entry` holds a lock younger than an hour. */
function lockedSince(entry: string, now: number): boolean {
	try {
		return now - statSync(join(entry, "locked")).mtimeMs < LOCK_STALE_MS;
	} catch {
		// No lock on it.
		return false;
	}
}

/** The git folder a worktree's `.git` file names, or nothing. */
function namedGitDir(path: string): string | undefined {
	const said = /^gitdir: (.+)$/m.exec(readPlain(join(path, ".git")) ?? "")?.[1];
	return said === undefined ? undefined : resolve(path, said.trim());
}

/** What became of one stranded tree. */
export type SetAsideTree =
	| { kind: "set-aside"; path: string; aside: string }
	| { kind: "kept"; path: string; why: string }
	| { kind: "gone"; path: string }
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
 * `into`, and say where each went. One with a record moves only under
 * that record's lock while every session it names has ended, as the
 * sweep takes a tree, and its record goes with it. One gone by its turn,
 * as another reclaim or the sweep took it, is said to be. A move
 * refused leaves the tree where it was and says why, without holding
 * up the rest.
 */
export async function setAside(
	trees: readonly StrandedTree[],
	deps: SetAsideDeps,
): Promise<SetAsideTree[]> {
	const done: SetAsideTree[] = [];
	for (const tree of trees) {
		if (!existsSync(tree.path)) {
			done.push({ kind: "gone", path: tree.path });
			continue;
		}
		const aside = join(
			deps.into,
			`${basename(tree.path)}-${randomBytes(4).toString("hex")}`,
		);
		let refused: string | undefined;
		let gone = false;
		const move = async () => {
			try {
				mkdirSync(deps.into, { recursive: true });
				renameSync(tree.path, aside);
			} catch (error) {
				// Another reclaim, or the sweep, may have taken it first.
				gone = !existsSync(tree.path);
				refused = plainWords(
					error instanceof Error ? error.message : String(error),
				);
				return false;
			}
			unlink(aside);
			return true;
		};
		const real = resolvedPath(tree.path);
		const recorded = deps.records
			?.recall()
			.find((one) => resolvedPath(one.path) === real);
		if (recorded !== undefined && deps.records !== undefined) {
			const took = await deps.records.whileUnheld(recorded.path, move);
			if (took !== undefined) {
				done.push({ kind: "set-aside", path: tree.path, aside });
			} else if (gone) {
				done.push({ kind: "gone", path: tree.path });
			} else if (refused !== undefined) {
				done.push({ kind: "refused", path: tree.path, why: refused });
			} else if (!existsSync(tree.path)) {
				done.push({ kind: "gone", path: tree.path });
			} else if (
				!deps.records.recall().some((one) => resolvedPath(one.path) === real)
			) {
				done.push({
					kind: "kept",
					path: tree.path,
					why: "its record went while it was asked about, so it stays for the next reclaim",
				});
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
		else if (gone) done.push({ kind: "gone", path: tree.path });
		else done.push({ kind: "refused", path: tree.path, why: refused ?? "" });
	}
	return done;
}

/** The longest stretch of git's words said back. */
const WORDS_MAX = 200;

/**
 * Words from git or the guard, as one plain line said back: a path in
 * them may be anything a sandboxed command wrote into a `.git` file, so
 * its line breaks and control characters go and a long one is cut.
 */
export function plainWords(said: string): string {
	// Control characters of both sets, the marks that turn text's
	// direction, and the separators some readers break lines at.
	const flat = said
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: what it removes.
			/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g,
			" ",
		)
		.trim();
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
