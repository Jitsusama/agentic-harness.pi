/**
 * What git's status said of each tree a sweep judged, kept between
 * sweeps, so a tree that hasn't changed since is answered from it rather
 * than asked again. Most trees a sweep keeps are kept hour after hour
 * for the same reason, and asking each walks its files.
 *
 * Only a status that ran is kept, and only for a day. A tree counts as
 * changed when its HEAD, its branch's ref, its index or its own folder
 * moved. An edit deep in a tracked file moves none of those, so an
 * answer of clean can be out of date; a take reads the status again
 * before it removes anything, so that only costs a take that is
 * refused. An answer of dirty out of date keeps a tree a day longer.
 */

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Exec, ExecResult } from "../../lib/core/exec/index.ts";

/** How long an answer stands for a tree that hasn't changed. */
export const STATUS_REMEMBERED_MS = 24 * 60 * 60 * 1000;

/** One tree's last answer, and what the tree looked like when it was given. */
interface Remembered {
	seen: string;
	at: number;
	stdout: string;
}

/** An exec that answers unchanged trees' statuses, and saves what it learnt. */
export interface StatusMemory {
	exec: Exec;
	/** Writes what this sweep asked, and drops trees it didn't. */
	save(): void;
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
			const seen = lookOf(path);
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
			if (seen !== undefined && result.code === 0) {
				after[path] = { seen, at: now(), stdout: result.stdout };
			}
			return result;
		},
		save: () => {
			const aside = `${file}.writing`;
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

/**
 * What a tree looks like to its status, cheaply: its HEAD, the ref HEAD
 * names, its index and its own folder. Nothing when any can't be read,
 * which asks git.
 */
function lookOf(path: string): string | undefined {
	try {
		const gitDir = gitDirOf(path);
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const ref = /^ref: (.+)$/.exec(head)?.[1];
		const common = commonDirOf(gitDir);
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

/** The git folder a tree's `.git` names, or the folder itself. */
function gitDirOf(path: string): string {
	const dotGit = join(path, ".git");
	if (statSync(dotGit).isDirectory()) return dotGit;
	const said = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
	if (said === undefined) throw new Error(`${dotGit} names no git folder`);
	return resolve(path, said.trim());
}

/** The repository's own git folder, which a worktree's `commondir` names. */
function commonDirOf(gitDir: string): string {
	try {
		const said = readFileSync(join(gitDir, "commondir"), "utf8").trim();
		return resolve(gitDir, said);
	} catch {
		// A main checkout's git folder is its own common folder.
		return gitDir;
	}
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
