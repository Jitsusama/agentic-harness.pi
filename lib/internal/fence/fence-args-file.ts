/**
 * bubblewrap's arguments for a fenced command, kept in a file bubblewrap
 * reads through `--args` rather than written into the command's text.
 * The text goes to bash as one string, in its argument list or, from pi's
 * shell, in a variable, and Linux refuses any one string over 128 KiB
 * (MAX_ARG_STRLEN) with E2BIG. The arguments grow with the trees a
 * session holds: on 19 November a session holding 93 trees made 290 KB of
 * them, and every fenced command failed to start. Read through a file,
 * they cost the text a line whatever their size.
 *
 * The file is one of the fence's copies (`fence-copy.ts`), in pi's folder
 * in the runtime folder, which inside the fence is emptied, so no fenced
 * command can rewrite what the next is fenced with. It is named by what
 * it holds, so a session's every command with the same arguments reads
 * the one file; each use renews it, and those unused for a day are
 * removed.
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

/** What each arguments file's name starts with, in the fence's copies. */
const PREFIX = "bwrap-args-";

/** How long an arguments file nothing read stays. */
const UNUSED_FOR_MS = 24 * 60 * 60_000;

/** How often a process looks for unused arguments files. */
const SWEEP_EVERY_MS = 60 * 60_000;

/** When this process last looked for unused arguments files. */
let sweptAt = 0;

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
): string | undefined {
	if (args.some((arg) => arg.includes("\0"))) return undefined;
	const text = args.map((arg) => `${arg}\0`).join("");
	const name = `${PREFIX}${createHash("sha256").update(text).digest("hex")}`;
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

/** Remove the arguments files in `folder` unused for a day. */
function sweepUnused(folder: string, now: number): void {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// Nothing to sweep: the next sweep looks again.
		return;
	}
	for (const name of names) {
		if (!name.startsWith(PREFIX)) continue;
		const path = join(folder, name);
		try {
			if (now - statSync(path).mtimeMs > UNUSED_FOR_MS) rmSync(path);
		} catch {
			// Gone already, or kept for the next sweep.
		}
	}
}
