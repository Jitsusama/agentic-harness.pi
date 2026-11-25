/**
 * Placing a carried session's file where `pi --session <id>` finds it,
 * once its trees have arrived ([`arrive.ts`](arrive.ts)). A log carried
 * gzipped is unzipped first, never past a bound, so a gzip that unzips
 * to a thousand times its size can't fill the disk.
 */

import {
	createReadStream,
	createWriteStream,
	mkdirSync,
	mkdtempSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { removeTree } from "../files/remove-tree.ts";
import { placeTakenOver } from "../quest/reopening/carried.ts";
import { ZIPPED } from "./carry-away.ts";

/**
 * The most a gzipped session file is unzipped to: 2 GiB. Logs gzip
 * about four to one, so the largest the share carries, 64 MiB gzipped,
 * unzips to about 256 MiB, an eighth of it. A gzip of 64 MiB can unzip
 * to a thousand times its size, which would fill the scratch's disk, so
 * unzipping stops there.
 */
export const LARGEST_UNZIPPED = 2 * 1024 * 1024 * 1024;

/** Where a session is placed, and how far its file may unzip. */
export interface Placing {
	/** The quest's scratch folder here, which the handover folder lies in; its tmp/ is never shared. */
	readonly scratch: string;
	/** pi's session store. */
	readonly sessions: string;
	/** The most a gzipped session file unzips to; `LARGEST_UNZIPPED` unless a test names less. */
	readonly largestUnzipped?: number;
}

/**
 * Places the session `id` carried at `file` for `cwd`, as
 * `placeTakenOver` does, answering where. A file carried gzipped, as
 * one larger than the share takes is, is unzipped first into the
 * scratch's tmp/, which is never shared, under its own name, and that
 * copy is removed once placed. One that unzips past
 * `placing.largestUnzipped` is refused, saying so, once it passes it.
 */
export async function placeSession(
	id: string,
	file: string,
	cwd: string,
	placing: Placing,
): Promise<string | undefined> {
	if (!file.endsWith(ZIPPED)) {
		return placeTakenOver(id, file, cwd, placing.sessions);
	}
	const tmp = join(placing.scratch, "tmp");
	mkdirSync(tmp, { recursive: true });
	const unzipping = mkdtempSync(join(tmp, "arriving-"));
	try {
		const plain = join(unzipping, basename(file).slice(0, -ZIPPED.length));
		await pipeline(
			createReadStream(file),
			createGunzip(),
			atMost(placing.largestUnzipped ?? LARGEST_UNZIPPED),
			createWriteStream(plain),
		);
		return placeTakenOver(id, plain, cwd, placing.sessions);
	} finally {
		removeTree(unzipping);
	}
}

/** What a session file pi wrote is named with. */
const SESSION_LOG = ".jsonl";

/**
 * Whether a carried session file's name is one of the forms arriving
 * here reads: a log as pi wrote it, or one gzipped. A harness older than
 * a form a newer one carries in, as one before the gzip was for a
 * `.jsonl.gz`, could only say the file held another session.
 */
export function isReadForm(name: string): boolean {
	return name.endsWith(SESSION_LOG) || name.endsWith(`${SESSION_LOG}${ZIPPED}`);
}

/**
 * A step of a pipeline that passes on what it is given until that
 * passes `largest` bytes, and then fails, saying so.
 */
function atMost(
	largest: number,
): (source: AsyncIterable<Buffer>) => AsyncGenerator<Buffer> {
	return async function* (source) {
		let passed = 0;
		for await (const chunk of source) {
			passed += chunk.length;
			if (passed > largest) {
				throw new Error(
					`it unzips to more than ${mib(largest)} MiB, the most arriving unzips, so it wasn't unzipped further`,
				);
			}
			yield chunk;
		}
	};
}

/** `bytes` in MiB, whole when it is whole. */
function mib(bytes: number): string {
	const inMib = bytes / (1024 * 1024);
	return Number.isInteger(inMib) ? String(inMib) : inMib.toFixed(1);
}
