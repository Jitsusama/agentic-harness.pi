/**
 * Putting a payload on disk so an answer does not have to carry
 * it.
 *
 * The write is exclusive rather than checked-then-created,
 * because two tools answering at once is ordinary and a lost
 * payload is not: a handle that resolved to somebody else's bytes
 * would be worse than having no store at all.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Owner only, since a payload can hold anything the tool saw. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** How many names to try before admitting defeat on collisions. */
const MAX_NAME_ATTEMPTS = 1_000;

/**
 * Write text into a directory under an unguessable name and
 * return the path.
 *
 * The directory is created when missing and resolved through its
 * real path, so a handle never depends on a symlink that later
 * changes where it points.
 */
export function spillText(text: string, dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	const realDir = fs.realpathSync(dir);
	const stem = `result-${crypto.randomBytes(8).toString("hex")}`;
	const bytes = Buffer.from(text, "utf-8");
	for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
		const name = attempt === 1 ? `${stem}.json` : `${stem}-${attempt}.json`;
		const candidate = path.join(realDir, name);
		try {
			// The exclusive flag is the whole point: create or fail,
			// never overwrite.
			fs.writeFileSync(candidate, bytes, { flag: "wx", mode: FILE_MODE });
			return candidate;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
	}
	throw new Error(
		`could not find a free name for a spilled result in ${realDir} ` +
			`after ${MAX_NAME_ATTEMPTS} attempts`,
	);
}
