/**
 * What the indexer keeps beside each log it read, so a pass over a grown
 * log reads only what was added since.
 *
 * A pass re-read every grown log whole: on 14 November 2026 one read
 * 1,210 MB to take in 29.9 MB of new lines, in 704 s. Beside each log it
 * reads, a pass now keeps where it stopped and what its scan knew there.
 * The next pass trusts that only while the log is still the same file,
 * still holds the bytes it stopped after, and the scan's state is of the
 * shape this code writes; anything else reads the log whole, as before.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	type Stats,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import {
	CARRY_VERSION,
	readCarry,
	SCAN_VERSION,
	type ScanState,
	writeCarry,
} from "../../lib/ledger/index.ts";

/** The folder beside the watermarks that holds what each log carried. */
const FOLDER = "ledger-resume";

/** How much of the log just before where a pass stopped is checked unchanged. */
const CHECKED_BYTES = 4096;

/**
 * How long a log's carry is kept after its last pass. A log idle past
 * this, its session most likely over, is read whole if it ever grows
 * again, which keeps the folder to the logs still being written.
 */
const KEPT_FOR_MS = 2 * 24 * 60 * 60 * 1000;

/** Where a pass stopped in one log, and what its scan knew there. */
interface Kept {
	/** The carry's shape and the scan's, either of which may have moved on. */
	readonly version: number;
	readonly scanVersion: number;
	/** The file it was, by device and inode, so a replaced log is told. */
	readonly dev: number;
	readonly ino: number;
	/** The byte after the last whole line read. */
	readonly offset: number;
	/** A digest of the bytes just before it. */
	readonly before: string;
	readonly state: unknown;
}

function isKept(value: unknown): value is Kept {
	if (!isRecord(value)) return false;
	return (
		["version", "scanVersion", "dev", "ino", "offset"].every(
			(name) => typeof value[name] === "number",
		) && typeof value.before === "string"
	);
}

/** What a pass may carry on from in one log, or why it reads it whole. */
export type Carried =
	| { readonly offset: number; readonly state: ScanState }
	| { readonly refused: string }
	| undefined;

/** The folder of carries for a ledger whose watermarks are at `watermarks`. */
export function carriedFolder(watermarks: string): string {
	return join(dirname(watermarks), FOLDER);
}

function keptPath(folder: string, log: string): string {
	const name = createHash("sha256").update(log).digest("hex").slice(0, 24);
	return join(folder, `${name}.json`);
}

/** A digest of the bytes of a log just before `offset`. */
function digestBefore(log: string, offset: number): string {
	const start = Math.max(0, offset - CHECKED_BYTES);
	const bytes = Buffer.alloc(offset - start);
	const fd = openSync(log, "r");
	try {
		readSync(fd, bytes, 0, bytes.length, start);
	} finally {
		closeSync(fd);
	}
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * What the last pass over `log` left to carry on from, given the log as
 * it stands. Nothing when it left nothing; a refusal, naming the log
 * and why, when what it left can't be trusted.
 */
export function carriedFor(folder: string, log: string, now: Stats): Carried {
	const path = keptPath(folder, log);
	if (!existsSync(path)) return undefined;
	const refused = (why: string) => ({ refused: `${basename(log)}: ${why}` });
	let kept: unknown;
	try {
		kept = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return refused("what the last pass carried could not be read");
	}
	if (!isKept(kept)) return refused("what the last pass carried has no shape");
	if (kept.version !== CARRY_VERSION || kept.scanVersion !== SCAN_VERSION)
		return refused("what the last pass carried is of an older kind");
	if (kept.dev !== now.dev || kept.ino !== now.ino)
		return refused("another file has taken the log's place");
	if (now.size < kept.offset)
		return refused("the log is shorter than where the last pass stopped");
	if (digestBefore(log, kept.offset) !== kept.before)
		return refused("the log changed before where the last pass stopped");
	const state = readCarry(kept.state);
	if (!state) return refused("what the last pass carried has no shape");
	return { offset: kept.offset, state };
}

/**
 * Keep where a pass stopped in `log` and what its scan knew there.
 * Called only once the pass's rows are in the store, so a carry never
 * runs ahead of what the ledger holds. Written whole, so a pass cut
 * short leaves the last carry or this one, never half of either.
 */
export function keepCarried(
	folder: string,
	log: string,
	file: Stats,
	offset: number,
	state: ScanState,
): void {
	const kept: Kept = {
		version: CARRY_VERSION,
		scanVersion: SCAN_VERSION,
		dev: file.dev,
		ino: file.ino,
		offset,
		before: digestBefore(log, offset),
		state: writeCarry(state),
	};
	writeWhole(keptPath(folder, log), JSON.stringify(kept));
}

/** Let go of the carries no pass has written for `KEPT_FOR_MS`. */
export function pruneCarried(folder: string, now = Date.now()): void {
	if (!existsSync(folder)) return;
	for (const name of readdirSync(folder)) {
		if (!name.endsWith(".json")) continue;
		const path = join(folder, name);
		try {
			if (now - statSync(path).mtimeMs > KEPT_FOR_MS) rmSync(path);
		} catch {
			// Gone already, or another pass is pruning beside this one;
			// either way it's no longer kept, which is what was wanted.
		}
	}
}
