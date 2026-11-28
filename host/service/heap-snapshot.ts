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
 * among them, so it is written owner-only, in a hidden folder, `.raw`,
 * that only its owner can enter, inside a folder only its owner can
 * enter, and the journal names who asked for it, as the asker named
 * itself, so each copy of those secrets has someone to answer for it.
 *
 * Once written, the request is answered with the raw file and where its
 * summary will be, and the snapshot is summed by type, figures only
 * (heap-summary.ts), into an owner-only `.summary.json` beside `.raw`,
 * so whoever asked reads that and never needs to open the raw file. The
 * sum runs in a node process of its own rather than a worker thread, so
 * the conversation's thread, which already paused once for the write,
 * never pauses for it, and none of its memory is the conversation's
 * process's to hold or give back. The journal says when the summary is
 * written and how long it took, or why it failed, in which case the raw
 * file stays.
 *
 * Whoever asked removes the raw file once summed, and each new snapshot
 * first removes any raw file or summary older than SNAPSHOT_KEPT_MS, so
 * one forgotten is gone within hours rather than kept for good. One whose
 * write fails is removed at once, since a partial file is no snapshot at
 * all.
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
import { sumApart } from "./heap-summary.ts";

/** Only the owner may enter the folders snapshots are written in. */
const OWNER_ONLY_FOLDER = 0o700;
/** Only the owner may read a snapshot, which holds the process's secrets. */
const OWNER_ONLY_FILE = 0o600;
const BYTES_PER_MIB = 1024 * 1024;
const MS_PER_MINUTE = 60_000;
/** How long a snapshot or summary is kept before the next one's sweep removes it. */
export const SNAPSHOT_KEPT_MS = 2 * 60 * 60 * 1000;
/** The hidden folder, inside the snapshot folder, that raw snapshots go in. */
export const RAW_FOLDER = ".raw";
const SNAPSHOT_SUFFIX = ".heapsnapshot";
const SUMMARY_SUFFIX = ".summary.json";

/** Where a host writes heap snapshots' summaries, and their raw files in its RAW_FOLDER, unless told. */
export function snapshotFolder(): string {
	return join(stateDir("host-service"), "heap-snapshots");
}

/** What a snapshot wrote, as the request is answered. */
export interface Snapshot {
	readonly sessionId: string;
	/** The raw snapshot, in the snapshot folder's RAW_FOLDER. */
	readonly file: string;
	/** Where its summary will be written, once summed. */
	readonly summary: string;
	readonly bytes: number;
	readonly tookMs: number;
}

/** How a snapshot is made: where, by what, and what the journal hears. */
export interface SnapshotPlaces {
	readonly folder?: string;
	/** Writes the snapshot to the file named; V8's own unless given. */
	readonly write?: (file: string) => void;
	/**
	 * Sums the raw snapshot into the summary file named, settling once it
	 * has; heap-summary.ts's sumApart, in a process of its own, unless given.
	 */
	readonly sum?: (raw: string, into: string) => Promise<void>;
	readonly now?: () => Date;
	readonly clock?: () => number;
	readonly say?: (line: string) => void;
}

/**
 * Write a heap snapshot of this process for `sessionId`, which it runs
 * in `state`, as the caller named `by` asked, and answer where it went
 * and where its summary will be; refused while that conversation is
 * busy, since the write stops its thread. The sum starts once the
 * snapshot is written and runs on after the answer.
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
	const raws = join(folder, RAW_FOLDER);
	mkdirSync(raws, { recursive: true, mode: OWNER_ONLY_FOLDER });
	// mkdir leaves a folder that was already there as it stood.
	chmodSync(folder, OWNER_ONLY_FOLDER);
	chmodSync(raws, OWNER_ONLY_FOLDER);
	const now = places.now?.() ?? new Date();
	sweep(folder, now, places.say);
	const stamp = now.toISOString().replaceAll(":", "-");
	const file = join(raws, `${sessionId}-${stamp}${SNAPSHOT_SUFFIX}`);
	const summary = join(folder, `${sessionId}-${stamp}${SUMMARY_SUFFIX}`);
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
			`A heap snapshot of conversation ${sessionId}'s process, ${asked}, failed after ${clock() - started} ms, and its partial file was removed: ${reasonOf(error)}`,
		);
		throw error;
	}
	const tookMs = clock() - started;
	const bytes = statSync(file).size;
	places.say?.(
		`Wrote a heap snapshot of conversation ${sessionId}'s process, ${Math.round(bytes / BYTES_PER_MIB)} MiB, to ${file}, ${asked}; its thread stopped for ${tookMs} ms`,
	);
	sumInBackground(file, summary, places);
	return { sessionId, file, summary, bytes, tookMs };
}

/**
 * Sum `file` into `summary` without waiting, saying in the journal when
 * it is written and how long it took, or why it failed, leaving the raw
 * file where it is either way.
 */
function sumInBackground(
	file: string,
	summary: string,
	places: SnapshotPlaces,
): void {
	const clock = places.clock ?? Date.now;
	const sum = places.sum ?? sumApart;
	const started = clock();
	// The answer goes first; a sum that throws as it starts fails as one
	// that rejects does, never in the request's own call.
	Promise.resolve()
		.then(() => sum(file, summary))
		.then(
			() =>
				places.say?.(
					`Summed heap snapshot ${file} into ${summary} in ${clock() - started} ms`,
				),
			(error: unknown) =>
				places.say?.(
					`Heap snapshot ${file} could not be summed after ${clock() - started} ms, so the raw file stays for its asker, or the sweep once ${SNAPSHOT_KEPT_MS / MS_PER_MINUTE} minutes old: ${reasonOf(error)}`,
				),
		);
}

/** Why `error` happened, as a line for the journal. */
function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Remove every raw snapshot and summary under `folder` last written more
 * than SNAPSHOT_KEPT_MS before `now`, saying each. Only files named as a
 * snapshot or a summary are touched, so nothing else kept there is lost.
 * Raw snapshots are looked for beside the summaries too, where a host
 * from before RAW_FOLDER wrote them.
 */
function sweep(
	folder: string,
	now: Date,
	say: ((line: string) => void) | undefined,
): void {
	const kinds = [
		{
			in: join(folder, RAW_FOLDER),
			suffix: SNAPSHOT_SUFFIX,
			what: "heap snapshot",
		},
		{ in: folder, suffix: SNAPSHOT_SUFFIX, what: "heap snapshot" },
		{ in: folder, suffix: SUMMARY_SUFFIX, what: "heap snapshot summary" },
	];
	for (const kind of kinds) {
		for (const name of readdirSync(kind.in)) {
			if (!name.endsWith(kind.suffix)) continue;
			const file = join(kind.in, name);
			// Whoever asked may remove theirs between the listing and here.
			const written = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
			if (written === undefined) continue;
			if (now.getTime() - written <= SNAPSHOT_KEPT_MS) continue;
			rmSync(file, { force: true });
			say?.(
				`Removed ${kind.what} ${file}, written ${Math.round((now.getTime() - written) / MS_PER_MINUTE)} minutes ago`,
			);
		}
	}
}
