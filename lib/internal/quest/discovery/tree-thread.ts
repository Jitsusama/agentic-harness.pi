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

/**
 * The exits of the threads ended at their wall that haven't exited yet.
 * A thread held in a synchronous read can't end until the read returns,
 * so on a disk that stays hung each signing would leave one more behind.
 * One set a process, kept on `globalThis`, since a reload evaluates this
 * module again and a copy's own set would let each copy leave one more.
 */
const heldInRead: Set<Promise<unknown>> = heldThreads();

/** The process's set of held threads, made by the first copy to ask. */
function heldThreads(): Set<Promise<unknown>> {
	const store = globalThis as Record<symbol, unknown>;
	const key = Symbol.for("agentic-harness.quest.tree-threads-held.v1");
	const held = store[key];
	if (held instanceof Set) return held;
	const made = new Set<Promise<unknown>>();
	store[key] = made;
	return made;
}

/** A thread refused since one is still held in a read: the disk hangs. */
export class ThreadsHeld extends Error {
	constructor(held: number) {
		super(`${held} thread still held in a read past its wall, so none starts`);
		this.name = "ThreadsHeld";
	}
}

/**
 * Whether `error` is a refusal for a held thread, from any loaded copy
 * of this module, as one from before a reload is.
 */
export function threadsHeld(error: unknown): boolean {
	return error instanceof Error && error.name === "ThreadsHeld";
}

/** How many threads may be held in a read before no more start. */
const HELD_AT_MOST = 1;

/** How long a thread being ended has to exit before it counts as held. */
const ENDS_WITHIN_MS = 1_000;

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
 * never the host's own; while one is held so, past `ENDS_WITHIN_MS`
 * after its wall, no other starts, and each is refused with
 * `ThreadsHeld`.
 */
export async function answerInThread(
	program: string,
	data: unknown,
	wallMs: number,
): Promise<unknown> {
	if (heldInRead.size >= HELD_AT_MOST) await anyHeldEnds(ENDS_WITHIN_MS);
	if (heldInRead.size >= HELD_AT_MOST) throw new ThreadsHeld(heldInRead.size);
	return new Promise((resolve, reject) => {
		let done = false;
		// The program needs none of the host's flags, and some refuse a
		// file: a process run with --input-type, as a test's child is,
		// fails every thread that inherits it.
		const thread = new Worker(program, { workerData: data, execArgv: [] });
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
		const wall = setTimeout(() => {
			// A wall passes only before the thread answers, errs or exits.
			const exited = new Promise((ended) => thread.once("exit", ended));
			heldInRead.add(exited);
			void exited.then(() => heldInRead.delete(exited));
			finish(() => reject(new Error(`no answer within ${wallMs} ms`)));
		}, wallMs);
		wall.unref();
		thread.unref();
		thread.once("message", (answer: unknown) => finish(() => resolve(answer)));
		thread.once("error", (error) => finish(() => reject(error)));
		thread.once("exit", (code) =>
			finish(() => reject(new Error(`the thread ended (${code}) unanswered`))),
		);
	});
}

/** Resolves once a held thread exits, or after `ms`, whichever is first. */
function anyHeldEnds(ms: number): Promise<void> {
	return new Promise((resolve) => {
		// Not a wait for something to happen: how long an ending may take.
		const within = setTimeout(resolve, ms);
		within.unref();
		void Promise.race(heldInRead).then(() => {
			clearTimeout(within);
			resolve();
		});
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
