/**
 * Takes what a strict session left in its outbox out of it, from
 * outside, for the node that hands a session's work back.
 *
 * A strict session writes its own outbox (`outboxFolder`) and nothing
 * else outside its work, so it can write anything there: a link to a
 * file it can't read, a FIFO that would hang a reader, a hard link to
 * another file, a file too large to carry. So only plain files are
 * taken, each opened without following a link and without waiting on
 * one that isn't a file, and checked again once open to be the file
 * that was looked at, held by one name, and no larger than `most`
 * bytes. Nothing below the outbox is walked: a folder there is refused,
 * as anything but a plain file is. Each file is copied into a folder
 * the taker names, as a new file it alone may read, never over one
 * already there, and named with its sha-256 so the taker can check what
 * it carried. The taking stops at its deadline, leaving the rest.
 *
 * It runs as the session's account, or one with less reach, never as
 * root: a file the session could plant is then one it could read anyway.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/** How much a taking reads at most, and for how long. */
export interface OutboxLimits {
	/** The most bytes one file may hold. */
	readonly most: number;
	/** When the taking stops, as `Date.now()` reads it. */
	readonly deadline: number;
}

/** What taking one entry of the outbox came to. */
export type OutboxEntry =
	| {
			readonly name: string;
			readonly taken: true;
			readonly bytes: number;
			readonly sha256: string;
	  }
	| { readonly name: string; readonly taken: false; readonly why: string };

/** What a taking came to: each entry, or why none was read. */
export type OutboxTaking =
	| { readonly entries: readonly OutboxEntry[] }
	| { readonly refused: string };

/** How a file is opened: never through a link, never waiting on a FIFO. */
const OPEN_TO_READ =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** How a copy is made: new, never through a link, the taker's alone. */
const OPEN_TO_WRITE =
	constants.O_WRONLY |
	constants.O_CREAT |
	constants.O_EXCL |
	constants.O_NOFOLLOW;

/** A copy's mode: the taker's alone. */
const COPY_MODE = 0o600;

/** How much is read at a time. */
const CHUNK = 64 * 1024;

/**
 * Takes each plain file in the outbox `from` into the folder `into`, as
 * `limits` allow. The whole taking is refused when either folder isn't
 * a plain folder, or can't be listed.
 */
export function takeOutbox(
	from: string,
	into: string,
	limits: OutboxLimits,
): OutboxTaking {
	for (const [what, folder] of [
		["outbox", from],
		["folder to take into", into],
	] as const) {
		const seen = lstatSync(folder, { throwIfNoEntry: false });
		if (seen === undefined || !seen.isDirectory()) {
			return {
				refused: `the ${what} ${folder} is missing, a link or not a folder`,
			};
		}
	}
	let names: string[];
	try {
		names = readdirSync(from).sort();
	} catch (error) {
		return { refused: `the outbox ${from} can't be listed (${String(error)})` };
	}
	const entries: OutboxEntry[] = [];
	for (const name of names) {
		if (Date.now() > limits.deadline) {
			entries.push({ name, taken: false, why: "the taking ran out of time" });
			continue;
		}
		entries.push(takeOne(name, from, into, limits.most));
	}
	return { entries };
}

/** Takes the entry `name` of `from` into `into`, as a file of at most `most` bytes. */
function takeOne(
	name: string,
	from: string,
	into: string,
	most: number,
): OutboxEntry {
	const refused = (why: string): OutboxEntry => ({ name, taken: false, why });
	const path = join(from, name);
	const looked = lstatSync(path, { throwIfNoEntry: false });
	if (looked === undefined) return refused("it went before it was read");
	if (!looked.isFile()) return refused("it isn't a plain file");
	let source: number;
	try {
		source = openSync(path, OPEN_TO_READ);
	} catch (error) {
		return refused(
			`it can't be opened without following it (${String(error)})`,
		);
	}
	try {
		const open = fstatSync(source);
		if (!open.isFile() || open.ino !== looked.ino || open.dev !== looked.dev) {
			return refused("it changed between looking and opening");
		}
		if (open.nlink !== 1) return refused("it has another name, a hard link");
		if (open.size > most) {
			return refused(`it holds ${open.size} bytes, more than ${most}`);
		}
		const read = readAtMost(source, most);
		if (read === undefined) return refused(`it grew past ${most} bytes`);
		const copied = copyInto(join(into, name), read);
		if (copied) return refused(copied);
		const sha256 = createHash("sha256").update(read).digest("hex");
		return { name, taken: true, bytes: read.length, sha256 };
	} finally {
		closeSync(source);
	}
}

/** All of `file`, or none when it holds more than `most` bytes. */
function readAtMost(file: number, most: number): Buffer | undefined {
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const chunk = Buffer.alloc(CHUNK);
		const got = readSync(file, chunk, 0, CHUNK, null);
		if (got === 0) return Buffer.concat(chunks, total);
		total += got;
		if (total > most) return undefined;
		chunks.push(chunk.subarray(0, got));
	}
}

/**
 * Writes `bytes` as the new file `path`, or says why it couldn't; one
 * that failed partway is left as far as it got, for the taker to see by
 * its sha-256.
 */
function copyInto(path: string, bytes: Buffer): string | undefined {
	let copy: number;
	try {
		copy = openSync(path, OPEN_TO_WRITE, COPY_MODE);
	} catch (error) {
		return `it can't be copied to ${path}, which may already be there (${String(error)})`;
	}
	try {
		let written = 0;
		while (written < bytes.length) {
			written += writeSync(copy, bytes, written);
		}
		return undefined;
	} catch (error) {
		return `its copy at ${path} couldn't be written whole (${String(error)})`;
	} finally {
		closeSync(copy);
	}
}
