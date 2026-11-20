/**
 * The lists a fenced command's text would otherwise carry in full, kept
 * in files the command reads: bubblewrap's arguments, read through its
 * `--args`, and the paths the after-check guards (`fence-git-root.ts`),
 * read by one loop. The text goes to bash as one string, in its argument
 * list or, from pi's shell, in a variable, and Linux refuses any one
 * string over 128 KiB (MAX_ARG_STRLEN) with E2BIG. Both lists grow with
 * the trees a session holds: on 19 November a session holding 93 trees
 * made 290 KB of arguments, and every fenced command failed to start.
 * Read from files, they cost the text a line each whatever their size.
 *
 * Each file is one of the fence's copies (`fence-copy.ts`), in pi's
 * folder in the runtime folder, which inside the fence is emptied, so no
 * fenced command can rewrite what the next is fenced with or checked
 * against. It is named by what it holds, so every command with the same
 * list reads the one file; each use renews it, and those unused for a
 * day are removed, so a command running all day still finds its own.
 */

import { createHash } from "node:crypto";
import {
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import { fenceCopy } from "./fence-copy.ts";

/** What each kind of list file's name starts with, in the fence's copies. */
const PREFIXES = {
	args: "bwrap-args-",
	guarded: "guarded-",
} as const;

/** How long a list file nothing read stays. */
const UNUSED_FOR_MS = 24 * 60 * 60_000;

/** How often a process looks for unused list files. */
const SWEEP_EVERY_MS = 60 * 60_000;

/**
 * The most arguments bubblewrap takes, its own and those its `--args`
 * reads together (MAX_ARGS in bubblewrap.c); past it bubblewrap refuses
 * to start.
 */
export const BWRAP_MOST_ARGS = 9000;

/** When this process last looked for unused list files. */
let sweptAt = 0;

/** bubblewrap's arguments, and the file holding them for `--args`. */
export interface ArgsFile {
	/** The file, each argument ended by a NUL. */
	readonly path: string;
	/** What it holds. */
	readonly args: readonly string[];
}

/**
 * The file holding `args` as bubblewrap's `--args` reads them, each
 * ended by a NUL, or nothing when there is no runtime folder or the file
 * can't be written, for the caller to pass them in its text instead. An
 * argument holding a NUL can't be passed either way, so there is no
 * file for one.
 */
export function bwrapArgsFile(
	runtimeDir: string | undefined,
	args: readonly string[],
	now: () => number = Date.now,
): ArgsFile | undefined {
	const path = listFile(runtimeDir, "args", args, now);
	return path ? { path, args } : undefined;
}

/**
 * The file holding the paths the after-check guards, each ended by a
 * NUL, or nothing, as for `bwrapArgsFile`.
 */
export function guardedListFile(
	runtimeDir: string | undefined,
	paths: readonly string[],
	now: () => number = Date.now,
): string | undefined {
	return listFile(runtimeDir, "guarded", paths, now);
}

/** The file of `kind` holding `items`, written or renewed. */
function listFile(
	runtimeDir: string | undefined,
	kind: keyof typeof PREFIXES,
	items: readonly string[],
	now: () => number,
): string | undefined {
	if (items.some((item) => item.includes("\0"))) return undefined;
	const text = items.map((item) => `${item}\0`).join("");
	const name = `${PREFIXES[kind]}${createHash("sha256").update(text).digest("hex")}`;
	const path = fenceCopy(runtimeDir, name, text, readIfThere);
	if (!path) return undefined;
	const moment = now();
	try {
		const at = new Date(moment);
		utimesSync(path, at, at);
	} catch {
		// Not renewed, it may be swept a day after it was written, and the
		// next command that needs it writes it again.
	}
	if (moment - sweptAt >= SWEEP_EVERY_MS) {
		sweptAt = moment;
		sweepUnused(join(path, ".."), moment);
	}
	return path;
}

/** What `path` holds, or nothing when it can't be read. */
function readIfThere(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// Not there or unreadable: it is written afresh.
		return undefined;
	}
}

/** Remove the list files in `folder` unused for a day, and nothing else. */
function sweepUnused(folder: string, now: number): void {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// Nothing to sweep: the next sweep looks again.
		return;
	}
	const prefixes = Object.values(PREFIXES);
	for (const name of names) {
		if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
		const path = join(folder, name);
		try {
			if (now - statSync(path).mtimeMs > UNUSED_FOR_MS) rmSync(path);
		} catch {
			// Gone already, or kept for the next sweep.
		}
	}
}
