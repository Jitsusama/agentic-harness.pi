/**
 * Reads a commit message file for the `git commit -F <file>`
 * path, resolving the path the way the shell would before the
 * command runs.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolve a raw `-F` path against the home directory (for `~`),
 * an absolute path directly, or the command's `cd` base
 * directory (falling back to the process cwd) for a relative
 * path.
 */
function resolvePath(rawPath: string, baseDir: string | null): string {
	if (rawPath === "~") return homedir();
	if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
	if (isAbsolute(rawPath)) return rawPath;
	return resolve(baseDir ?? process.cwd(), rawPath);
}

/** Read a commit message file, or null when it cannot be read. */
export function readCommitFile(
	rawPath: string,
	baseDir: string | null,
): string | null {
	try {
		return readFileSync(resolvePath(rawPath, baseDir), "utf8");
	} catch {
		// Fail open: an unreadable file (missing, permissions, a path
		// with unexpanded shell variables) means no attribution and no
		// gate for this commit, never a wrong rewrite. The caller
		// treats null as "no message found".
		return null;
	}
}
