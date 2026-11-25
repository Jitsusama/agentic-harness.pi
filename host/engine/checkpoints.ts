/**
 * Checkpoints for the conversations' stores, off the host's thread.
 *
 * Each store is SQLite in WAL mode with `synchronous = NORMAL`, so a commit
 * never syncs; a checkpoint does, twice. SQLite runs one itself inside a
 * commit once the log holds 1,000 pages not yet copied back, and every call
 * on node's `DatabaseSync` runs on the thread that called it: the host's one
 * thread, which every conversation's screen and turn share. While /home's
 * btrfs commits a transaction, that sync waits for it, and the host's loop
 * holds with it (the hold watch saw 38 of the stores' 61 samples there).
 *
 * So a store opened here is opened with no checkpoint of its own, and one
 * worker per host keeps a second connection to each, checkpointing it
 * PASSIVE once the log holds the same 1,000 pages not yet copied back, and
 * once more as it closes. PASSIVE never waits on the writer. A worker that
 * dies is started again with every store it kept, at most a few times;
 * after that, each store's close checkpoints it, as it always has, with
 * its log longer meanwhile.
 *
 * How much of a log is still to copy is read from the store's WAL index
 * (its `-shm` file), whose layout SQLite documents: the frames the log
 * holds less those already copied back. The log file's own length says
 * nothing once a checkpoint has copied it, since PASSIVE never shrinks it.
 *
 * The index is read through one descriptor per store that the process
 * keeps for its life and never closes. SQLite locks the index with POSIX
 * locks, and closing any descriptor on a file drops every lock its process
 * holds there. Opened and closed every 2 s, it left each conversation
 * unlocked, so another process opening the store took itself for the
 * first, rebuilt the index smaller under the live writer, and the writer's
 * next frame faulted past its end: a conversation of 3 days died so on 25
 * November, with SIGBUS in SQLite's walIndexAppend.
 *
 * Closing it even at a store's release would race: a conversation can open
 * the store again before the worker reads the release, and a worker that
 * ends can overlap the next. So none is ever closed. The main thread opens
 * each one, not the worker, since node closes what a worker opened when
 * the worker exits, and the worker ends with the last store released. An
 * index replaced, as SQLite does once the store's last connection has
 * closed and the next opens it, is read through a new descriptor the
 * worker asks for; the old one stays open, holding a file of a block or
 * two, one per reopening.
 *
 * Two connections to one store in one process are safe because both are
 * node's one built-in SQLite, which shares its locks within the process;
 * a store opened through another SQLite build in this process would not be.
 */

import { fstatSync, openSync, statSync } from "node:fs";
import { endianness } from "node:os";
import { Worker } from "node:worker_threads";

/** How often the worker looks at each store's log, in ms. */
const EVERY_MS = 2000;

/** The log's pages not yet copied back, past which a store is checkpointed: SQLite's own. */
const PAGES = 1000;

/**
 * How long a close waits for its checkpoint, in ms, before closing all the
 * same. A host's stop closes every conversation at once and has 45 s, so
 * every close's wait, which runs together, takes a fraction of it.
 */
const SETTLE_MS = 10_000;

/** How many times a worker that died is started again before the stores are left to their closes. */
const RESTARTS = 3;

/**
 * The worker, as source for an eval worker, so it needs nothing resolved.
 * It takes node's modules through `process.getBuiltinModule`, which either
 * module type has: a thread takes its process's flags, so under a host
 * started with `--input-type=module`, as the host's end-to-end runs start
 * it, a `require` here threw and no store was checkpointed until it closed.
 *
 * A store being closed is checkpointed once and then left alone until it
 * is released or kept again. Should a close's own TRUNCATE still meet this
 * connection mid-checkpoint, as after a settle that ran out its wait, it
 * waits at most the store's busy timeout, 5 s, and then closes; the last
 * connection to close, this one as it is released, copies what remains.
 */
const PROGRAM = `
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { existsSync, fstatSync, readSync, statSync } = process.getBuiltinModule("node:fs");
const { every, pages, observing, little } = workerData;
const kept = new Map();
// Each store's WAL index descriptor, which the main thread opened and holds.
const indexes = new Map(Object.entries(workerData.indexes));
// The stores whose index this has asked the main thread for, not yet answered.
const asked = new Set();
const said = (error) => String((error && error.message) || error);
// Both copies of the WAL index's 48-byte header and the checkpoint's count after them.
const index = Buffer.alloc(100);
function open(path) {
	let store = kept.get(path);
	if (store) return store;
	// Never makes a store: one already gone has nothing to checkpoint.
	if (!existsSync(path)) throw new Error("the store is gone");
	const db = new DatabaseSync(path, { timeout: 0 });
	store = { db, closing: false, failing: false };
	kept.set(path, store);
	return store;
}
function failed(path, store, error) {
	// Said once until it checkpoints again, not at every look.
	if (store && store.failing) return;
	if (store) store.failing = true;
	parentPort.postMessage({ op: "failed", path, error: said(error) });
}
function checkpoint(path, store) {
	store.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
	store.failing = false;
	if (observing) parentPort.postMessage({ op: "checkpointed", path });
}
// The descriptor a store's WAL index is read through. None is opened or
// closed here: closing one drops SQLite's locks on it, and node closes one
// a worker opened when the worker exits. For an index missing or since
// replaced this asks the main thread, and reads what it holds meanwhile.
function indexOf(path) {
	const held = indexes.get(path);
	try {
		if (held !== undefined && statSync(path + "-shm").ino === fstatSync(held).ino) return held;
	} catch {
		// Gone for now, or not yet made: the main thread looks again.
	}
	if (!asked.has(path)) {
		asked.add(path);
		parentPort.postMessage({ op: "index", path });
	}
	return held;
}
// The frames the log holds not yet copied back, read from its WAL index:
// the header's mxFrame at byte 16 and the checkpoint's nBackfill at byte
// 96, in the machine's own byte order. An index that can't be read counts
// as nothing to copy, leaving the store to its close.
function stillToCopy(path) {
	try {
		const fd = indexOf(path);
		if (fd === undefined || readSync(fd, index, 0, index.length, 0) < index.length) return 0;
	} catch {
		return 0;
	}
	const frames = little ? index.readUInt32LE(16) : index.readUInt32BE(16);
	const copied = little ? index.readUInt32LE(96) : index.readUInt32BE(96);
	return frames > copied ? frames - copied : 0;
}
parentPort.on("message", (message) => {
	const { op, path } = message;
	if (op === "keep" || op === "index") {
		if (op === "index") asked.delete(path);
		if (typeof message.fd === "number") indexes.set(path, message.fd);
		if (op === "index") return;
		try {
			open(path).closing = false;
		} catch (error) {
			failed(path, undefined, error);
		}
	} else if (op === "settle") {
		let error;
		try {
			const store = open(path);
			store.closing = true;
			checkpoint(path, store);
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
			failed(path, undefined, error);
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
		if (store.closing || stillToCopy(path) <= pages) continue;
		try {
			checkpoint(path, store);
		} catch (error) {
			failed(path, store, error);
		}
	}
	if (observing) parentPort.postMessage({ op: "looked" });
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

/** What the worker did, for a test to watch. */
export type CheckpointEvent =
	| { readonly op: "looked" }
	| { readonly op: "checkpointed"; readonly path: string };

/** What a checkpointer is told. */
export interface CheckpointOptions {
	/** Said when a store can't be checkpointed, a close's wait runs out, or the worker fails. */
	readonly report?: (error: unknown) => void;
	/** How often the log is looked at, in ms. */
	readonly every?: number;
	/** The log's pages not yet copied back past which it is checkpointed. */
	readonly pages?: number;
	/** How long a close waits for its checkpoint, in ms. */
	readonly settleWithin?: number;
	/** Told each time the worker looks and each checkpoint it makes; a host passes none. */
	readonly observe?: (event: CheckpointEvent) => void;
}

/** A worker's answer, as it posts one. */
interface Answer {
	readonly op: "settled" | "failed" | "looked" | "checkpointed" | "index";
	readonly id?: number;
	readonly path: string;
	readonly error?: string;
}

const ANSWERS = new Set([
	"settled",
	"failed",
	"looked",
	"checkpointed",
	"index",
]);

/**
 * Each store's WAL index descriptor, by the store's path, opened on the
 * main thread and held for the process's life: every worker, restarted or
 * started again, reads through the same one, and none is closed.
 */
const INDEXES = new Map<string, number>();

/**
 * The descriptor on the WAL index of the store at `path`, opened once and
 * again only for an index since replaced; none while it has no index.
 */
function indexFor(path: string): number | undefined {
	const at = `${path}-shm`;
	const held = INDEXES.get(path);
	try {
		if (held !== undefined && statSync(at).ino === fstatSync(held).ino)
			return held;
		const fd = openSync(at, "r");
		INDEXES.set(path, fd);
		return fd;
	} catch {
		// No index yet, or gone: the worker asks again at its next look.
		return held;
	}
}

/** Whether something the worker posted is an answer. */
function isAnswer(value: unknown): value is Answer {
	if (typeof value !== "object" || value === null) return false;
	return ANSWERS.has(String(Reflect.get(value, "op")));
}

/**
 * Checkpoint the host's stores from one worker, started with the first store
 * kept and ended with the last released, so a host with none holds no thread.
 */
export function checkpointing(options: CheckpointOptions = {}): Checkpoints {
	const report = options.report ?? (() => {});
	const settleWithin = options.settleWithin ?? SETTLE_MS;
	// How many conversations keep each store, so one closing leaves another's be.
	const kept = new Map<string, number>();
	// Each close waiting, with the thread it waits on, so a thread that
	// ends lets go only of its own.
	const waiting = new Map<
		number,
		{ readonly thread: Worker; readonly done: () => void }
	>();
	let next = 0;
	let worker: Worker | undefined;
	let restarts = 0;

	function settleAllOf(thread: Worker): void {
		for (const [id, one] of waiting) {
			if (one.thread !== thread) continue;
			waiting.delete(id);
			one.done();
		}
	}

	function heard(thread: Worker, message: unknown): void {
		if (!isAnswer(message)) return;
		if (message.op === "index") {
			const path = message.path;
			thread.postMessage({ op: "index", path, fd: indexFor(path) });
			return;
		}
		if (message.op === "looked" || message.op === "checkpointed") {
			options.observe?.(
				message.op === "looked"
					? { op: "looked" }
					: { op: "checkpointed", path: message.path },
			);
			return;
		}
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
	}

	function started(): Worker {
		if (worker) return worker;
		const thread = new Worker(PROGRAM, {
			eval: true,
			workerData: {
				every: options.every ?? EVERY_MS,
				pages: options.pages ?? PAGES,
				observing: options.observe !== undefined,
				little: endianness() === "LE",
				indexes: Object.fromEntries(INDEXES),
			},
		});
		thread.unref();
		thread.on("message", (message: unknown) => heard(thread, message));
		thread.on("error", (error: unknown) => {
			const said = error instanceof Error ? error.message : String(error);
			report(new Error(`The stores' checkpoint thread failed: ${said}`));
		});
		thread.on("exit", () => {
			// Whatever it was doing, a close waiting on it closes and checkpoints by itself.
			settleAllOf(thread);
			if (worker !== thread) return;
			worker = undefined;
			// A thread asked to end is no longer the worker by now; this one died with stores still kept.
			if (kept.size === 0) return;
			if (restarts >= RESTARTS) {
				report(
					new Error(
						`The stores' checkpoint thread died ${RESTARTS + 1} times; each of the ${kept.size} stores still open is checkpointed only as it closes`,
					),
				);
				return;
			}
			restarts++;
			const again = started();
			for (const path of kept.keys())
				again.postMessage({ op: "keep", path, fd: indexFor(path) });
		});
		worker = thread;
		return thread;
	}

	function settle(path: string): Promise<void> {
		// A worker given up on leaves the close's own TRUNCATE to it.
		if (!worker && restarts >= RESTARTS) return Promise.resolve();
		const thread = started();
		const id = next++;
		return new Promise<void>((resolve) => {
			// Held, not unref'd, so a stop's close isn't cut off while it waits; never past this.
			const timer = setTimeout(() => {
				waiting.delete(id);
				report(
					new Error(
						`Closing ${path} without its checkpoint, which didn't settle in ${settleWithin / 1000} s`,
					),
				);
				resolve();
			}, settleWithin);
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
		const keeping = kept.get(path);
		if (keeping === undefined) return;
		if (keeping > 1) {
			kept.set(path, keeping - 1);
			return;
		}
		kept.delete(path);
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
			kept.set(path, (kept.get(path) ?? 0) + 1);
			if (worker || restarts < RESTARTS)
				started().postMessage({ op: "keep", path, fd: indexFor(path) });
			let released = false;
			return {
				settle: () => settle(path),
				release: () => {
					// Once a keep's own: a second call would let go of another's.
					if (released) return;
					released = true;
					release(path);
				},
			};
		},
	};
}
