/**
 * Where a file tool's path points, as pi's read, write and edit tools
 * read it first: unicode spaces made plain, a leading `@` dropped, `~`
 * for the home folder, a `file://` address as the path it names, and
 * anything relative taken from the conversation's folder. The spellings
 * pi tries next, when that file is missing, are the sandbox's to read
 * (`lib/internal/sandbox/sandbox-files.ts`).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Unicode spaces pi reads as plain ones in a path a tool is given. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** The file `path` names, read from `cwd` as pi's file tools read it. */
export function toolPath(
	path: string,
	cwd: string,
	home: string = homedir(),
): string {
	let given = path.replace(UNICODE_SPACES, " ");
	if (given.startsWith("@")) given = given.slice(1);
	if (given === "~") given = home;
	else if (given.startsWith("~/")) given = join(home, given.slice(2));
	if (given.startsWith("file://")) given = fileURLToPath(given);
	return isAbsolute(given) ? resolve(given) : resolve(cwd, given);
}
