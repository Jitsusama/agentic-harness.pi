/**
 * A heap snapshot of the process a conversation runs in, written when
 * someone asks for one, so what a long-lived child holds can be named by
 * what retains it rather than guessed from its size. The two children
 * 3PXQTB and A2VLJN measured on 27 November held about 300 MiB of old
 * space beyond their whole history and extensions, and nothing else in a
 * running child can be read for it: children run with SIGUSR1 off, so no
 * inspector can be opened in one.
 *
 * Writing one stops the process's thread for as long as V8 walks its
 * heap, seconds for a heap of hundreds of MiB, so it is refused while the
 * conversation is busy, and the journal says how long each one took. A
 * snapshot holds every string the process holds, its environment's keys
 * among them, so it is written owner-only, in a folder only its owner can
 * enter, and the journal names who asked for it, as the asker named
 * itself, so each copy of those secrets has someone to answer for it.
 * Whoever asked removes it once summed, and each new snapshot first
 * removes any in the folder older than SNAPSHOT_KEPT_MS, so one forgotten
 * is gone within hours rather than kept for good. One whose write fails
 * is removed at once, since a partial file is no snapshot at all.
 */

import {
	chmodSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { stateDir } from "../../lib/internal/paths.ts";
import { askedBy, hostRefusal } from "./dispatch.ts";

/** Only the owner may enter the folder snapshots are written in. */
const OWNER_ONLY_FOLDER = 0o700;
/** Only the owner may read a snapshot, which holds the process's secrets. */
const OWNER_ONLY_FILE = 0o600;
const BYTES_PER_MIB = 1024 * 1024;
/** How long a snapshot is kept before the next one's sweep removes it. */
export const SNAPSHOT_KEPT_MS = 2 * 60 * 60 * 1000;
const SNAPSHOT_SUFFIX = ".heapsnapshot";

/** Where a host writes heap snapshots unless told. */
export function snapshotFolder(): string {
	return join(stateDir("host-service"), "heap-snapshots");
}

/** What a snapshot wrote, as the request is answered. */
export interface Snapshot {
	readonly sessionId: string;
	readonly file: string;
	readonly bytes: number;
	readonly tookMs: number;
}

/** How a snapshot is made: where, by what, and what the journal hears. */
export interface SnapshotPlaces {
	readonly folder?: string;
	/** Writes the snapshot to the file named; V8's own unless given. */
	readonly write?: (file: string) => void;
	readonly now?: () => Date;
	readonly clock?: () => number;
	readonly say?: (line: string) => void;
}

/**
 * Write a heap snapshot of this process for `sessionId`, which it runs
 * in `state`, as the caller named `by` asked, and answer where it went;
 * refused while that conversation is busy, since the write stops its
 * thread.
 */
export function snapshotHeap(
	sessionId: string,
	state: string,
	by: string | undefined,
	places: SnapshotPlaces = {},
): Snapshot {
	if (state === "busy")
		throw hostRefusal(
			"busy",
			`Conversation ${sessionId} is busy, and a heap snapshot stops its thread while it is written; ask again once it is idle`,
		);
	const folder = places.folder ?? snapshotFolder();
	mkdirSync(folder, { recursive: true, mode: OWNER_ONLY_FOLDER });
	// mkdir leaves a folder that was already there as it stood.
	chmodSync(folder, OWNER_ONLY_FOLDER);
	const now = places.now?.() ?? new Date();
	sweep(folder, now, places.say);
	const stamp = now.toISOString().replaceAll(":", "-");
	const file = join(folder, `${sessionId}-${stamp}${SNAPSHOT_SUFFIX}`);
	// Made owner-only before V8 writes into it, which keeps a file's mode,
	// so its privacy rests on this rather than on what mode a Node makes
	// one with (24 makes it owner-only); and never over one already there.
	writeFileSync(file, "", { mode: OWNER_ONLY_FILE, flag: "wx" });
	const asked = `asked by ${askedBy(by)}`;
	const clock = places.clock ?? Date.now;
	const started = clock();
	try {
		(places.write ?? ((into) => writeHeapSnapshot(into)))(file);
	} catch (error) {
		rmSync(file, { force: true });
		places.say?.(
			`A heap snapshot of conversation ${sessionId}'s process, ${asked}, failed after ${clock() - started} ms, and its partial file was removed: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	}
	const tookMs = clock() - started;
	const bytes = statSync(file).size;
	places.say?.(
		`Wrote a heap snapshot of conversation ${sessionId}'s process, ${Math.round(bytes / BYTES_PER_MIB)} MiB, to ${file}, ${asked}; its thread stopped for ${tookMs} ms`,
	);
	return { sessionId, file, bytes, tookMs };
}

/**
 * Remove every snapshot in `folder` last written more than
 * SNAPSHOT_KEPT_MS before `now`, saying each. Only files named as a
 * snapshot are touched, so nothing else kept there is lost.
 */
function sweep(
	folder: string,
	now: Date,
	say: ((line: string) => void) | undefined,
): void {
	for (const name of readdirSync(folder)) {
		if (!name.endsWith(SNAPSHOT_SUFFIX)) continue;
		const file = join(folder, name);
		// Whoever asked may remove theirs between the listing and here.
		const written = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
		if (written === undefined) continue;
		if (now.getTime() - written <= SNAPSHOT_KEPT_MS) continue;
		rmSync(file, { force: true });
		say?.(
			`Removed heap snapshot ${file}, written ${Math.round((now.getTime() - written) / 60_000)} minutes ago`,
		);
	}
}
