/**
 * Reads a commit message file for the `git commit -F <file>`
 * path, resolving the path the way the shell would before the
 * command runs.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { hosted } from "../../session/index.ts";
import { commitCwd } from "./commit-shell.ts";

/**
 * Resolve a raw `-F` path against the home directory (for `~`),
 * an absolute path directly, or the command's `cd` base
 * directory for a relative path. Plain pi keeps its process cwd
 * fallback; a host never guesses when the command directory is unknown.
 */
function resolvePath(rawPath: string, baseDir: string | null): string | null {
	if (rawPath === "~") return homedir();
	if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
	if (isAbsolute(rawPath)) return rawPath;
	if (baseDir === null && hosted()) return null;
	return resolve(baseDir ?? commitCwd(), rawPath);
}

/** Read a commit message file, or null when it cannot be read. */
export function readCommitFile(
	rawPath: string,
	baseDir: string | null,
): string | null {
	try {
		const path = resolvePath(rawPath, baseDir);
		return path === null ? null : readFileSync(path, "utf8");
	} catch {
		// Fail open: an unreadable file (missing, permissions, a path
		// with unexpanded shell variables) means no attribution and no
		// gate for this commit, never a wrong rewrite. The caller
		// treats null as "no message found".
		return null;
	}
}
