/**
 * Where a file tool's path points, as pi's read, write and edit tools
 * read it: a leading `@` dropped, `~` for the home folder, and anything
 * relative taken from the conversation's folder.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The file `path` names, read from `cwd` as pi's file tools read it. */
export function toolPath(path: string, cwd: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	if (bare === "~") return homedir();
	if (bare.startsWith("~/")) return join(homedir(), bare.slice(2));
	return resolve(cwd, bare);
}
