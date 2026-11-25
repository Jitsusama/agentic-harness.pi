/**
 * What git's status said of each tree a sweep judged, kept between
 * sweeps, so a tree that hasn't changed since is answered from it rather
 * than asked again. Most trees a sweep keeps are kept hour after hour
 * for the same reason, and asking each walks its files.
 *
 * Only a status that ran is kept, only for a day, and only for the same
 * question asked again. A tree counts as changed when its HEAD's text,
 * its branch's ref, packed-refs, its index or the entries of its own top
 * folder moved, and only then. An edit to a tracked file, or a file
 * added or removed in a folder below the top, moves none of those, so an
 * answer of clean can be out of date. A take reads the status again
 * before it removes anything, and a tree whose take was refused is
 * forgotten, so a stale clean answer costs one take that is refused: the
 * tree is moved aside, read and put back once. An answer of dirty out of
 * date keeps a tree a day longer.
 */

import {
	lstatSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Exec, ExecResult } from "../../lib/core/exec/index.ts";
import { readPlain } from "../../lib/core/work/plain-file.ts";

/** How long an answer stands for a tree that hasn't changed. */
export const STATUS_REMEMBERED_MS = 24 * 60 * 60 * 1000;

/**
 * The longest answer kept. A tree with more changes than this is asked
 * again each sweep rather than carried, as the file is read and written
 * whole on a host's thread.
 */
const STATUS_KEPT_BYTES = 64 * 1024;

/** One tree's last answer, and what the tree looked like when it was given. */
interface Remembered {
	seen: string;
	at: number;
	stdout: string;
}

/** An exec that answers unchanged trees' statuses, and saves what it learnt. */
export interface StatusMemory {
	exec: Exec;
	/**
	 * Writes what this sweep asked, dropping trees it didn't and the
	 * `refused` ones, whose take found the answer out of date.
	 */
	save(refused?: readonly string[]): void;
}

/**
 * Remember statuses in `file`, running every other command, and every
 * status of a changed tree, through `exec`.
 */
export function rememberStatuses(
	exec: Exec,
	file: string,
	now: () => number = Date.now,
): StatusMemory {
	const before = readRemembered(file);
	const after: Record<string, Remembered> = {};
	return {
		exec: async (command, args) => {
			const path = statusOf(command, args);
			if (path === undefined) return await exec(command, args);
			const look = lookOf(path);
			// The question is part of what was seen: clean to one status's
			// flags isn't clean to another's.
			const seen =
				look === undefined ? undefined : JSON.stringify([args, look]);
			const old = before[path];
			if (
				seen !== undefined &&
				old !== undefined &&
				old.seen === seen &&
				now() - old.at < STATUS_REMEMBERED_MS
			) {
				after[path] = old;
				return { code: 0, stdout: old.stdout, stderr: "" };
			}
			const result: ExecResult = await exec(command, args);
			if (
				seen !== undefined &&
				result.code === 0 &&
				result.stdout.length <= STATUS_KEPT_BYTES
			) {
				after[path] = { seen, at: now(), stdout: result.stdout };
			}
			return result;
		},
		save: (refused = []) => {
			const forgotten = new Set(refused.map(samePath));
			for (const path of Object.keys(after)) {
				if (forgotten.has(samePath(path))) delete after[path];
			}
			// A name of its own, so two sweeps saving at once can't tear it.
			const aside = `${file}.${process.pid}.writing`;
			try {
				writeFileSync(aside, JSON.stringify(after));
				renameSync(aside, file);
			} catch {
				// Unwritten, the next sweep asks every tree again, as before.
			}
		},
	};
}

/** The tree a git status is asked of, or nothing for any other command. */
function statusOf(
	command: string,
	args: readonly string[],
): string | undefined {
	if (command !== "git" || !args.includes("status")) return undefined;
	const at = args.indexOf("-C");
	const path = at === -1 ? undefined : args[at + 1];
	return path === undefined || !isAbsolute(path) ? undefined : path;
}

/** `path` as the file system names it, so two spellings of one tree match. */
function samePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Gone, so only its spelling is left to match.
		return resolve(path);
	}
}

/**
 * What a tree looks like to its status, cheaply: its HEAD, the ref HEAD
 * names, packed-refs, its index and its own folder. Nothing when any
 * can't be read, which asks git.
 *
 * Every file git keeps for a tree is read through {@link readPlain}: the
 * tree's `.git` names them, and whatever ran in the tree could make one
 * a fifo, whose read would never return and would hold the host's thread.
 */
function lookOf(path: string): string | undefined {
	try {
		const gitDir = gitDirOf(path);
		if (gitDir === undefined) return undefined;
		const head = readPlain(join(gitDir, "HEAD"))?.trim();
		if (head === undefined) return undefined;
		const ref = /^ref: (.+)$/.exec(head)?.[1];
		const common = commonDirOf(gitDir);
		if (common === undefined) return undefined;
		const index = statSync(join(gitDir, "index"));
		return JSON.stringify([
			head,
			ref === undefined ? undefined : changed(join(common, ref)),
			changed(join(common, "packed-refs")),
			index.mtimeMs,
			index.size,
			statSync(path).mtimeMs,
		]);
	} catch {
		// A tree mid-change, or not a worktree: git says.
		return undefined;
	}
}

/** When `path` last changed, or nothing when there is none. */
function changed(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		// A ref only in packed-refs, which counts on its own.
		return undefined;
	}
}

/**
 * The git folder a tree's `.git` names, or the folder itself, or nothing
 * when `.git` is neither a plain folder nor a plain file naming one.
 */
function gitDirOf(path: string): string | undefined {
	const dotGit = join(path, ".git");
	if (lstatSync(dotGit).isDirectory()) return dotGit;
	const text = readPlain(dotGit);
	const said =
		text === undefined ? undefined : /^gitdir: (.+)$/m.exec(text)?.[1];
	return said === undefined ? undefined : resolve(path, said.trim());
}

/**
 * The repository's own git folder, which a worktree's `commondir` names:
 * the git folder itself when there is none, and nothing when one stands
 * there that isn't a plain file.
 */
function commonDirOf(gitDir: string): string | undefined {
	const at = join(gitDir, "commondir");
	const said = readPlain(at)?.trim();
	if (said !== undefined) return resolve(gitDir, said);
	try {
		lstatSync(at);
	} catch {
		// A main checkout's git folder is its own common folder.
		return gitDir;
	}
	return undefined;
}

/** What the last sweep saved, or nothing when it saved none. */
function readRemembered(file: string): Record<string, Remembered> {
	try {
		const read: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof read !== "object" || read === null) return {};
		const kept: Record<string, Remembered> = {};
		for (const [path, one] of Object.entries(read)) {
			if (isRemembered(one)) kept[path] = one;
		}
		return kept;
	} catch {
		// None yet, or torn: every tree is asked.
		return {};
	}
}

/** Whether `one` reads as a saved answer. */
function isRemembered(one: unknown): one is Remembered {
	return (
		typeof one === "object" &&
		one !== null &&
		"seen" in one &&
		typeof one.seen === "string" &&
		"at" in one &&
		typeof one.at === "number" &&
		"stdout" in one &&
		typeof one.stdout === "string"
	);
}
