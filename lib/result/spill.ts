/**
 * Putting a payload on disk so an answer does not have to carry
 * it.
 *
 * A payload is named after its own content, which makes storing it
 * twice free. That is not a micro-optimization: a caller who
 * navigates, reads the page, clicks something and reads it again
 * generates the same outline several times over, and the first
 * version of this stored a separate megabyte for each of them
 * under a separate handle. Naming by content means one file, one
 * handle, and a handle that stays valid however many answers cite
 * it.
 *
 * The write is exclusive rather than checked-then-created, because
 * two tools answering at once is ordinary. With content
 * addressing a collision is not a conflict: whoever lost the race
 * wrote the same bytes, so the existing file is the correct answer.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Owner only, since a payload can hold anything the tool saw. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * How much of the digest names the file.
 *
 * Sixty-four bits, which for the number of payloads one session
 * can produce makes an accidental collision far less likely than
 * the disk lying about the write that stored it.
 */
const NAME_HEX_LENGTH = 16;

/** A stored payload, and whether it was already there. */
export interface SpilledPayload {
	readonly path: string;
	/** True when an identical payload was already stored. */
	readonly reused: boolean;
}

/**
 * Write text into a directory under a name derived from its
 * content, and return where it went.
 *
 * The directory is created when missing and resolved through its
 * real path, so a handle never depends on a symlink that later
 * changes where it points.
 */
export function spillText(text: string, dir: string): SpilledPayload {
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	const realDir = fs.realpathSync(dir);
	const digest = crypto
		.createHash("sha256")
		.update(text, "utf-8")
		.digest("hex")
		.slice(0, NAME_HEX_LENGTH);
	const target = path.join(realDir, `result-${digest}.json`);
	try {
		// Exclusive: create or fail, never overwrite.
		fs.writeFileSync(target, Buffer.from(text, "utf-8"), {
			flag: "wx",
			mode: FILE_MODE,
		});
		return { path: target, reused: false };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// Same name means same content, so what is already there is what
		// we were about to write. Touch it so the quota's oldest-first
		// eviction treats it as freshly used rather than as the stalest
		// payload in the directory, which is how a handle being cited
		// again would otherwise get itself evicted.
		try {
			const now = new Date();
			fs.utimesSync(target, now, now);
		} catch {
			// The timestamp is a hint for eviction order, not correctness.
		}
		return { path: target, reused: true };
	}
}
