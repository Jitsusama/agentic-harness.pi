/**
 * Checkpoints for the conversations' stores, off the host's thread.
 *
 * Each store is SQLite in WAL mode with `synchronous = NORMAL`, so a commit
 * never syncs; a checkpoint does, twice, and truncates. SQLite runs one
 * itself inside a commit once the log passes 1,000 pages, and every call on
 * node's `DatabaseSync` runs on the thread that called it: the host's one
 * thread, which every conversation's screen and turn share. While /home's
 * btrfs commits a transaction, that sync waits for it, and the host's loop
 * holds with it (the hold watch saw 38 of the stores' 61 samples there).
 *
 * So a store opened here is opened with no checkpoint of its own, and one
 * worker per host keeps a second connection to each, checkpointing it
 * PASSIVE once its log passes the same 1,000 pages, and once more as it
 * closes. PASSIVE never waits on the writer, and the close's own TRUNCATE
 * then finds nothing left to copy. A worker that fails leaves each store's
 * close to checkpoint it, as it always has, with the log longer meanwhile.
 */

import { Worker } from "node:worker_threads";

/** How often the worker looks at each store's log, in ms. */
const EVERY_MS = 2000;

/** The log's length, in pages, past which a store is checkpointed: SQLite's own. */
const PAGES = 1000;

/** How long a close waits for its checkpoint, in ms, before closing all the same. */
const SETTLE_MS = 30_000;

/**
 * The worker, as source for an eval worker, so it needs nothing resolved.
 * A store being closed is checkpointed once and then left alone, so the
 * close's own TRUNCATE never meets this connection mid-checkpoint.
 */
const PROGRAM = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
const { every, pages } = workerData;
const kept = new Map();
const said = (error) => String((error && error.message) || error);
function open(path) {
	let store = kept.get(path);
	if (store) return store;
	const db = new DatabaseSync(path, { timeout: 0 });
	const size = db.prepare("PRAGMA page_size").get().page_size;
	store = { db, size, closing: false };
	kept.set(path, store);
	return store;
}
function checkpoint(store) {
	store.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
}
function due(path, store) {
	try {
		return statSync(path + "-wal").size > pages * store.size;
	} catch {
		return false;
	}
}
parentPort.on("message", (message) => {
	const { op, path } = message;
	if (op === "keep") {
		try {
			open(path);
		} catch (error) {
			parentPort.postMessage({ op: "failed", path, error: said(error) });
		}
	} else if (op === "settle") {
		let error;
		try {
			const store = open(path);
			store.closing = true;
			checkpoint(store);
		} catch (caught) {
			error = said(caught);
		}
		parentPort.postMessage({ op: "settled", id: message.id, path, error });
	} else if (op === "release") {
		const store = kept.get(path);
		kept.delete(path);
		try {
			if (store) store.db.close();
		} catch (error) {
			parentPort.postMessage({ op: "failed", path, error: said(error) });
		}
	} else if (op === "end") {
		clearInterval(looking);
		for (const store of kept.values()) {
			try {
				store.db.close();
			} catch {
				// Ending: a connection that won't close goes with the thread.
			}
		}
		kept.clear();
		parentPort.close();
	}
});
const looking = setInterval(() => {
	for (const [path, store] of kept) {
		if (store.closing || !due(path, store)) continue;
		try {
			checkpoint(store);
		} catch (error) {
			parentPort.postMessage({ op: "failed", path, error: said(error) });
		}
	}
}, every);
`;

/** One store the host keeps checkpointed. */
export interface KeptStore {
	/** Checkpoint it now, as it closes, and leave it be after; settles within the wait, done or not. */
	settle(): Promise<void>;
	/** Stop keeping it, once it has closed. */
	release(): void;
}

/** The host's checkpoints. */
export interface Checkpoints {
	/** Keep the store at `path`, opened already in WAL mode with no checkpoint of its own. */
	keep(path: string): KeptStore;
	/** The connection options a store kept here is opened with. */
	readonly storeOptions: { readonly walAutoCheckpointPages: 0 };
}

/** What a checkpointer is told. */
export interface CheckpointOptions {
	/** Said when a store can't be checkpointed, or the worker fails. */
	readonly report?: (error: unknown) => void;
	/** How often the log is looked at, in ms. */
	readonly every?: number;
	/** The log's length in pages past which it is checkpointed. */
	readonly pages?: number;
	/** How long a close waits for its checkpoint, in ms. */
	readonly settleWithin?: number;
}

/** A worker's answer, as it posts one. */
interface Answer {
	readonly op: "settled" | "failed";
	readonly id?: number;
	readonly path: string;
	readonly error?: string;
}

/** Whether something the worker posted is an answer. */
function isAnswer(value: unknown): value is Answer {
	if (typeof value !== "object" || value === null) return false;
	const op: unknown = Reflect.get(value, "op");
	return op === "settled" || op === "failed";
}

/**
 * Checkpoint the host's stores from one worker, started with the first store
 * kept and ended with the last released, so a host with none holds no thread.
 */
export function checkpointing(options: CheckpointOptions = {}): Checkpoints {
	const report = options.report ?? (() => {});
	const settleWithin = options.settleWithin ?? SETTLE_MS;
	const kept = new Set<string>();
	// Each close waiting, with the thread it waits on, so a thread that
	// ends lets go only of its own.
	const waiting = new Map<
		number,
		{ readonly thread: Worker; readonly done: () => void }
	>();
	let next = 0;
	let worker: Worker | undefined;

	function settleAllOf(thread: Worker): void {
		for (const [id, one] of waiting) {
			if (one.thread !== thread) continue;
			waiting.delete(id);
			one.done();
		}
	}

	function started(): Worker {
		if (worker) return worker;
		const thread = new Worker(PROGRAM, {
			eval: true,
			workerData: {
				every: options.every ?? EVERY_MS,
				pages: options.pages ?? PAGES,
			},
		});
		thread.unref();
		thread.on("message", (message: unknown) => {
			if (!isAnswer(message)) return;
			if (message.error)
				report(
					new Error(
						`Couldn't checkpoint ${message.path} off the thread: ${message.error}`,
					),
				);
			if (message.op !== "settled" || message.id === undefined) return;
			const one = waiting.get(message.id);
			waiting.delete(message.id);
			one?.done();
		});
		thread.on("error", (error: unknown) => {
			const said = error instanceof Error ? error.message : String(error);
			report(new Error(`The stores' checkpoint thread failed: ${said}`));
		});
		// Whatever it was doing, a close waiting on it closes and checkpoints by itself.
		thread.on("exit", () => {
			if (worker === thread) worker = undefined;
			settleAllOf(thread);
		});
		worker = thread;
		return thread;
	}

	function settle(path: string): Promise<void> {
		const thread = started();
		const id = next++;
		return new Promise<void>((resolve) => {
			// A close never waits longer than this; its own TRUNCATE does the rest.
			const timer = setTimeout(() => {
				waiting.delete(id);
				resolve();
			}, settleWithin);
			timer.unref();
			waiting.set(id, {
				thread,
				done: () => {
					clearTimeout(timer);
					resolve();
				},
			});
			thread.postMessage({ op: "settle", id, path });
		});
	}

	function release(path: string): void {
		if (!kept.delete(path)) return;
		worker?.postMessage({ op: "release", path });
		if (kept.size > 0 || !worker) return;
		const thread = worker;
		worker = undefined;
		// Its last store released, it closes its connections and ends by itself.
		thread.postMessage({ op: "end" });
	}

	return {
		storeOptions: { walAutoCheckpointPages: 0 },
		keep(path) {
			kept.add(path);
			started().postMessage({ op: "keep", path });
			return {
				settle: () => settle(path),
				release: () => release(path),
			};
		},
	};
}
