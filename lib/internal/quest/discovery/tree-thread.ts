/**
 * The quest tree's reads, made on a thread of their own: every listing,
 * stat, real path and file a signing needs, answered to the host's
 * thread in one message. Read through the filesystem's promises on the
 * host's own thread, each of a signing's thousands of reads waited for
 * a turn there, behind every conversation's work: on 20 Nov, with 1,523
 * quests and a loop held for seconds at a time, a signing took 30 to 76
 * s, past the 30 s its asks wait, so every write resting on one was
 * refused. On this thread the reads run at the disk's pace, whatever
 * the host's thread is doing, and cost it one turn. They are made
 * synchronously, so they hold only this thread: read through promises,
 * they would take the process's filesystem threads, which every
 * conversation's own reads, lookups and compression wait on.
 */

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ID_PATTERN } from "../creation/id.ts";
import { CANONICAL_DOCUMENT_DIRS, MAX_WALK_DEPTH } from "./discovery-reads.ts";

/** A stat as the thread took it, with when it took it. */
export interface StatRead {
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	readonly ino: bigint;
	/** When it was taken, in nanoseconds since the epoch. */
	readonly at: bigint;
}

/** A listed entry's kind: folder, file, link, or anything else. */
export type EntryKind = "d" | "f" | "l" | "o";

/** What the thread read of a tree, in the order a signing reads it. */
export interface TreeRead {
	/** The root's stat, taken before anything else, if it is there. */
	readonly root: StatRead | null;
	/** Each folder listed, with its entries, or null for none. */
	readonly listings: readonly [
		string,
		(readonly [string, EntryKind])[] | null,
	][];
	/** Each folder's real path, or null when it couldn't be had. */
	readonly reals: readonly [string, string | null][];
	/**
	 * Each quest folder's stat and its README's, taken before the folder
	 * was listed: null for a folder not there, and for a README not there.
	 */
	readonly pending: readonly [string, StatRead | null, StatRead | null][];
	/**
	 * Each file's stat and bytes: no stat for one missing, unreadable or
	 * not a plain file; no bytes for one whose stat matched the one it
	 * was sent to skip under.
	 */
	readonly files: readonly [string, StatRead | null, Uint8Array | null][];
}

/** The program the thread runs, beside this file. */
const TREE_READ = fileURLToPath(new URL("./tree-read.mjs", import.meta.url));

/**
 * Read `questsRoot` on a thread of its own, reading no file whose stat
 * matches the key `skip` holds for it. Rejects as `answerInThread` does.
 */
export async function readTreeInThread(
	questsRoot: string,
	skip: ReadonlyMap<string, string>,
	wallMs: number,
): Promise<TreeRead> {
	const data = {
		root: questsRoot,
		skip: [...skip],
		depth: MAX_WALK_DEPTH,
		kinds: CANONICAL_DOCUMENT_DIRS,
		id: ID_PATTERN,
	};
	const answer = await answerInThread(TREE_READ, data, wallMs).catch(
		(error: unknown) => {
			throw new Error(`reading ${questsRoot}: ${error}`);
		},
	);
	if (isTreeRead(answer)) return answer;
	throw new Error(`reading ${questsRoot} failed: ${failure(answer)}`);
}

/**
 * The first message `program` sends, run on a thread of its own with
 * `data`. Rejects when the thread errs or exits unanswered, and after
 * `wallMs` without an answer, ending the thread. A disk that hangs in a
 * synchronous read then holds that thread until the read returns, but
 * never the host's own.
 */
export function answerInThread(
	program: string,
	data: unknown,
	wallMs: number,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let done = false;
		const thread = new Worker(program, { workerData: data });
		const finish = (end: () => void): void => {
			// The exit that follows an answer, or its ending, is not news.
			if (done) return;
			done = true;
			clearTimeout(wall);
			end();
			// Ending a thread that has answered only frees it.
			thread.terminate().catch(() => undefined);
		};
		// Not a wait for something to happen: a ceiling on a disk that hangs.
		const wall = setTimeout(
			() => finish(() => reject(new Error(`no answer within ${wallMs} ms`))),
			wallMs,
		);
		wall.unref();
		thread.unref();
		thread.once("message", (answer: unknown) => finish(() => resolve(answer)));
		thread.once("error", (error) => finish(() => reject(error)));
		thread.once("exit", (code) =>
			finish(() => reject(new Error(`the thread ended (${code}) unanswered`))),
		);
	});
}

function isTreeRead(answer: unknown): answer is TreeRead {
	return (
		typeof answer === "object" &&
		answer !== null &&
		"listings" in answer &&
		"files" in answer
	);
}

function failure(answer: unknown): string {
	return typeof answer === "object" && answer !== null && "failed" in answer
		? String(answer.failed)
		: "no answer";
}
