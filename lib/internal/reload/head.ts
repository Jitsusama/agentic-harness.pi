/**
 * A checkout's HEAD commit, read from the files git keeps it in.
 *
 * Saying which code runs used to ask `git rev-parse HEAD`, and every
 * child process a hosted conversation starts is forked from the host's
 * one loop, which every other conversation waits on: 459 ms of one turn
 * in a soak of twelve (13 November). HEAD is a file naming a commit or a
 * ref, and a ref is a file of its own or a line of `packed-refs`, so
 * reading them answers the same without a child. A checkout these
 * files can't answer for, such as one keeping its refs in a reftable,
 * reads as nothing, and the caller may ask git.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** A full commit name, as HEAD, a ref file or packed-refs writes it. */
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** How many refs naming refs to follow before giving up. */
const MOST_HOPS = 5;

/** The commit `root`'s HEAD names, or nothing when its files can't say. */
export function headFromFiles(root: string): string | undefined {
	const gitDir = gitDirOf(root);
	if (gitDir === undefined) return undefined;
	const commonDir = commonDirOf(gitDir);
	let said = read(join(gitDir, "HEAD"));
	for (let hop = 0; hop < MOST_HOPS && said !== undefined; hop++) {
		if (COMMIT.test(said)) return said;
		const ref = /^ref: (\S+)$/.exec(said)?.[1];
		if (ref === undefined) return undefined;
		said = refIn(gitDir, commonDir, ref);
	}
	return undefined;
}

/** The folder git keeps `root`'s repository in: `.git`, or where a worktree's `.git` file points. */
function gitDirOf(root: string): string | undefined {
	const dotGit = join(root, ".git");
	try {
		if (statSync(dotGit).isDirectory()) return dotGit;
	} catch {
		// No .git at all: not a checkout.
		return undefined;
	}
	const pointer = /^gitdir: (.+)$/.exec(read(dotGit) ?? "")?.[1];
	if (pointer === undefined) return undefined;
	return isAbsolute(pointer) ? pointer : resolve(root, pointer);
}

/** Where a worktree's shared refs are: what its `commondir` names, or its own folder. */
function commonDirOf(gitDir: string): string {
	const common = read(join(gitDir, "commondir"));
	if (common === undefined) return gitDir;
	return isAbsolute(common) ? common : resolve(gitDir, common);
}

/** What a ref says: its own file, a worktree's first, else its line in packed-refs. */
function refIn(
	gitDir: string,
	commonDir: string,
	ref: string,
): string | undefined {
	const loose = read(join(gitDir, ref)) ?? read(join(commonDir, ref));
	if (loose !== undefined) return loose;
	const packed = read(join(commonDir, "packed-refs"));
	for (const line of packed?.split("\n") ?? []) {
		const [commit, name] = line.split(" ");
		if (name === ref && commit !== undefined) return commit;
	}
	return undefined;
}

/** A file's text, trimmed, or nothing when it can't be read. */
function read(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		// No such file is a ref kept elsewhere, or none: the caller decides.
		return undefined;
	}
}
