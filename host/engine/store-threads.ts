/**
 * The conversations' stores, read and written off the host's thread.
 *
 * pi-durable reaches its SQLite through chord's `SqliteDatabase`, which is
 * asynchronous so an adapter may run elsewhere; its own Node adapter runs
 * every call on `DatabaseSync`, on the thread that called it. The host's
 * one thread draws every conversation's screen and runs every turn, so a
 * read that waits on the disk held all of them: the start of 18 November
 * spent 185 s in `pread64` on one store and was ready after 642 s. A
 * synchronous read can't be given a deadline, so it runs elsewhere.
 *
 * Each store opened here lives on one of a few worker threads, spread by
 * how many each already holds, so a read stalled in one store holds only
 * the stores beside it on that thread, and never the host's. The host's
 * side keeps chord's contract: calls run in the order made, a transaction
 * holds the store until it commits or rolls back, a transaction's handle
 * is refused once it settles, and a failed rollback rejects with an
 * AggregateError. The connection is set up as chord's own (WAL,
 * `synchronous = NORMAL`, a 5 s busy timeout) with the checkpoint pages
 * the caller names, and a close checkpoints TRUNCATE, as chord's does.
 *
 * A thread that dies fails every call it held and is started again with
 * each of its stores opened anew, but not one it was closing; SQLite rolls
 * back a transaction its connection took with it, and that transaction's
 * handle refuses from then on, so none of it is written outside it. One
 * that died as its transaction committed says it can't tell whether it
 * was written. A thread that dies a fourth time within ten minutes gives
 * its stores up, each refusing from then on, as does a store that can't
 * open again, and takes no store for ten minutes. A thread's stalled call
 * is said once, until the thread answers again.
 */

import { Worker } from "node:worker_threads";

/** How many threads the stores are spread across. */
const THREADS = 4;

/** How long a store waits for a competing lock, in ms: chord's own default. */
const BUSY_TIMEOUT_MS = 5000;

/** SQLite's own checkpoint threshold, in pages, for a store nothing else checkpoints. */
const CHECKPOINT_PAGES = 1000;

/** How many times a thread that died is started again within `RESTART_WINDOW_MS` before it gives its stores up. */
const RESTARTS = 3;

/** How long a thread's deaths are counted, and how long one that gave its stores up takes none, in ms. */
const RESTART_WINDOW_MS = 10 * 60_000;

/** How long a call waits on its thread before it is said to be stalled, in ms. */
const STALLED_MS = 30_000;

/**
 * The worker, as source for an eval worker, so it needs nothing resolved.
 * Statements are cached per store by their text, the 256 last used, as
 * chord's adapter does, so the store's callers can pass values as bindings.
 */
const PROGRAM = `
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const LIMIT = 256;
const stores = new Map();
// Why each store that failed to open did, for the calls already sent behind it.
const refused = new Map();
function statement(store, sql) {
	const statements = store.statements;
	let prepared = statements.get(sql);
	if (prepared !== undefined) {
		statements.delete(sql);
		statements.set(sql, prepared);
		return prepared;
	}
	prepared = store.db.prepare(sql);
	statements.set(sql, prepared);
	if (statements.size > LIMIT) statements.delete(statements.keys().next().value);
	return prepared;
}
function opened(message) {
	const db = new DatabaseSync(message.path, { timeout: message.timeout });
	try {
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA wal_autocheckpoint = " + Number(message.pages));
	} catch (error) {
		try {
			db.close();
		} catch {
			// The setup's failure is the one said.
		}
		throw error;
	}
	stores.set(message.store, { db, statements: new Map() });
}
function closed(key, store) {
	stores.delete(key);
	store.statements.clear();
	try {
		store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		store.db.close();
	}
}
function answer(message) {
	if (message.op === "open") {
		try {
			return opened(message);
		} catch (error) {
			refused.set(message.store, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
	const store = stores.get(message.store);
	if (!store) {
		const why = refused.get(message.store);
		if (message.op === "close") refused.delete(message.store);
		throw new Error(
			why === undefined
				? "The store isn't open on its thread"
				: "The store couldn't open again on its thread: " + why,
		);
	}
	if (message.op === "close") return closed(message.store, store);
	const { kind, sql, params } = message;
	if (kind === "exec") {
		store.db.exec(sql);
		return undefined;
	}
	const prepared = statement(store, sql);
	if (kind === "run") {
		prepared.run(...params);
		return undefined;
	}
	if (kind === "runCounted") return Number(prepared.run(...params).changes);
	if (kind === "get") return prepared.get(...params);
	if (kind === "all") return prepared.all(...params);
	throw new Error("No store call is named " + kind);
}
parentPort.on("message", (message) => {
	try {
		parentPort.postMessage({ id: message.id, value: answer(message) });
	} catch (error) {
		const failed = error instanceof Error ? error : new Error(String(error));
		parentPort.postMessage({
			id: message.id,
			error: { name: failed.name, message: failed.message, code: failed.code, errcode: failed.errcode },
		});
	}
});
`;

/** A value SQLite takes as a binding and gives back in a row. */
export type StoreValue = null | number | bigint | string | Uint8Array;

/** One store's calls, as chord's `SqliteExecutor` names them. */
export interface StoreExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: StoreValue[]): Promise<void>;
	runCounted(sql: string, ...params: StoreValue[]): Promise<number>;
	get<T extends object>(
		sql: string,
		...params: StoreValue[]
	): Promise<T | undefined>;
	all<T extends object>(sql: string, ...params: StoreValue[]): Promise<T[]>;
}

/** One store, as chord's `SqliteDatabase`: what pi-durable's `SqliteStorage.open` takes. */
export interface StoreDatabase extends StoreExecutor {
	transaction<T>(
		callback: (transaction: StoreExecutor) => Promise<T>,
	): Promise<T>;
	close(): Promise<void>;
}

/** How a store's connection is set up. */
export interface StoreOptions {
	/** SQLite's checkpoint threshold in pages; 0 when the host's checkpointer keeps the store. */
	readonly walAutoCheckpointPages?: number;
	/** How long a call waits for a competing lock, in ms. */
	readonly busyTimeoutMs?: number;
}

/** The host's store threads. */
export interface StoreThreads {
	/** Open the store at `path`, whose folder exists, on the thread holding fewest. */
	open(path: string, options?: StoreOptions): Promise<StoreDatabase>;
}

/** What the store threads are told. */
export interface StoreThreadOptions {
	/** Said when a thread fails or dies. */
	readonly report?: (error: unknown) => void;
	/** How many threads; a test may ask for one. */
	readonly threads?: number;
	/** How a thread's worker is started from its program; a test may keep one to end it. */
	readonly worker?: (program: string) => Worker;
	/** How long a call waits before it is said, in ms; a test may shorten it. */
	readonly stalledMs?: number;
	/** The time, in ms; a test may move it on past a thread's rest. */
	readonly now?: () => number;
}

/** A call the thread is asked to make. */
type Asked =
	| {
			readonly op: "open";
			readonly path: string;
			readonly timeout: number;
			readonly pages: number;
	  }
	| { readonly op: "close" }
	| {
			readonly op: "call";
			readonly kind: "exec" | "run" | "runCounted" | "get" | "all";
			readonly sql: string;
			readonly params: readonly StoreValue[];
	  };

/** A thread's answer, as it posts one. */
interface Answer {
	readonly id: number;
	readonly value?: unknown;
	readonly error?: {
		readonly name?: string;
		readonly message?: string;
		readonly code?: unknown;
		readonly errcode?: unknown;
	};
}

/** Whether something a thread posted is an answer. */
function isAnswer(value: unknown): value is Answer {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "id") === "number"
	);
}

/** The error a thread said, as an Error again, with SQLite's codes kept. */
function errorFrom(said: NonNullable<Answer["error"]>): Error {
	const error = new Error(said.message ?? "The store's call failed");
	if (said.name) error.name = said.name;
	if (said.code !== undefined) Reflect.set(error, "code", said.code);
	if (said.errcode !== undefined) Reflect.set(error, "errcode", said.errcode);
	return error;
}

/**
 * Which of a thread's workers a transaction began on, taken as its first
 * call is sent, so its later calls refuse any other.
 */
interface Pin {
	start?: number;
}

/** How a store is opened, kept to open it again. */
type Open = Extract<Asked, { op: "open" }>;

/** One worker thread and the stores it holds. */
interface Thread {
	worker: Worker | undefined;
	/** Counts the thread's workers, each start a new one. */
	start: number;
	/** When it died under its stores, within the last `RESTART_WINDOW_MS`. */
	deaths: number[];
	/** When it gave its stores up; it takes none until `RESTART_WINDOW_MS` on. */
	resting: number | undefined;
	/** Whether a stalled call has been said since it last answered. */
	stallSaid: boolean;
	/** Each store it holds, by key, with how to open it again. */
	readonly stores: Map<number, Open>;
	/** Each store whose close it was asked, never opened again. */
	readonly closing: Map<number, Open>;
	/** Each call it was asked and hasn't answered. */
	readonly waiting: Map<
		number,
		{
			readonly resolve: (value: unknown) => void;
			readonly reject: (error: Error) => void;
			readonly stalled: ReturnType<typeof setTimeout>;
		}
	>;
}

/**
 * Hold the host's stores on a few worker threads, each started with the
 * first store it's given and ended with the last closed, so a host with
 * none holds no thread.
 */
export function storeThreads(options: StoreThreadOptions = {}): StoreThreads {
	const report = options.report ?? (() => {});
	const threads: Thread[] = Array.from(
		{ length: Math.max(1, options.threads ?? THREADS) },
		() => ({
			worker: undefined,
			start: 0,
			deaths: [],
			resting: undefined,
			stallSaid: false,
			stores: new Map(),
			closing: new Map(),
			waiting: new Map(),
		}),
	);
	const now = options.now ?? Date.now;
	/** Each store a thread gave up, with why it refuses. */
	const givenUp = new Map<number, string>();
	const startWorker =
		options.worker ?? ((program) => new Worker(program, { eval: true }));
	const stalledMs = options.stalledMs ?? STALLED_MS;
	let nextId = 0;
	let nextStore = 0;

	/** Held while a call waits, so the host's loop doesn't end under one. */
	function holding(thread: Thread): void {
		if (thread.waiting.size > 0) thread.worker?.ref();
		else thread.worker?.unref();
	}

	function failAll(thread: Thread, error: Error): void {
		const waiting = [...thread.waiting.values()];
		thread.waiting.clear();
		thread.stallSaid = false;
		for (const one of waiting) {
			clearTimeout(one.stalled);
			one.reject(error);
		}
	}

	function started(thread: Thread): Worker {
		if (thread.worker) return thread.worker;
		const worker = startWorker(PROGRAM);
		worker.unref();
		worker.on("message", (message: unknown) => {
			if (!isAnswer(message)) return;
			const one = thread.waiting.get(message.id);
			if (!one) return;
			thread.waiting.delete(message.id);
			clearTimeout(one.stalled);
			thread.stallSaid = false;
			holding(thread);
			if (message.error) one.reject(errorFrom(message.error));
			else one.resolve(message.value);
		});
		worker.on("error", (error: unknown) => {
			const said = error instanceof Error ? error.message : String(error);
			report(new Error(`A store thread failed: ${said}`));
		});
		worker.on("exit", () => died(thread, worker));
		thread.worker = worker;
		thread.start++;
		return worker;
	}

	/** A worker ended under its stores: start it again, or, dying too often, give its stores up. */
	function died(thread: Thread, worker: Worker): void {
		if (thread.worker !== worker) return;
		thread.worker = undefined;
		failAll(thread, new Error("The store's thread ended under the call"));
		if (thread.stores.size === 0) return;
		const at = now();
		thread.deaths = thread.deaths.filter(
			(death) => at - death < RESTART_WINDOW_MS,
		);
		if (thread.deaths.length >= RESTARTS) {
			const count = thread.stores.size;
			for (const store of thread.stores.keys())
				givenUp.set(
					store,
					`The store's thread died ${RESTARTS + 1} times in ${RESTART_WINDOW_MS / 60_000} minutes and gave it up`,
				);
			thread.stores.clear();
			thread.deaths = [];
			thread.resting = at;
			report(
				new Error(
					`A store thread died ${RESTARTS + 1} times in ${RESTART_WINDOW_MS / 60_000} minutes; its ${count} stores refuse every call`,
				),
			);
			return;
		}
		thread.deaths.push(at);
		// Opened anew, in the order they were first opened.
		for (const [store, open] of thread.stores) {
			const pin: Pin = {};
			ask(thread, store, open, pin).catch((error: unknown) => {
				// A later start opens it again, or the thread has given it up.
				if (pin.start !== thread.start || !thread.stores.has(store)) return;
				thread.stores.delete(store);
				const said = error instanceof Error ? error.message : String(error);
				givenUp.set(
					store,
					`The store couldn't open again on its thread: ${said}`,
				);
				report(
					new Error(
						`The store at ${open.path} couldn't open again on its thread: ${said}`,
					),
				);
			});
		}
	}

	/**
	 * Ask the store's thread, starting it if it has ended. A store that has
	 * closed is refused without one. A pinned call is refused once the
	 * thread has started again since its pin was taken.
	 */
	function ask(
		thread: Thread,
		store: number,
		asked: Asked,
		pin?: Pin,
	): Promise<unknown> {
		const gone = givenUp.get(store);
		// A store given up has nothing open, so its close has nothing to do.
		if (gone)
			return asked.op === "close"
				? Promise.resolve(undefined)
				: Promise.reject(new Error(gone));
		const open =
			asked.op === "open"
				? asked
				: (thread.stores.get(store) ??
					(asked.op === "close" ? thread.closing.get(store) : undefined));
		if (!open) return Promise.reject(new Error("The store is closed"));
		const worker = started(thread);
		if (pin) {
			pin.start ??= thread.start;
			if (pin.start !== thread.start)
				return Promise.reject(
					new Error(
						"The store's thread started again under its transaction, which SQLite rolled back",
					),
				);
		}
		const id = nextId++;
		return new Promise((resolve, reject) => {
			// Said once, and the call still waits: a read stalled on the disk can't be ended.
			const stalled = setTimeout(() => {
				if (thread.stallSaid) return;
				thread.stallSaid = true;
				report(
					new Error(
						`A call to the store at ${open.path} has waited ${stalledMs / 1000} s on its thread, with ${thread.waiting.size} waiting there`,
					),
				);
			}, stalledMs);
			stalled.unref();
			thread.waiting.set(id, { resolve, reject, stalled });
			holding(thread);
			try {
				worker.postMessage({ ...asked, id, store });
			} catch (error) {
				// Never sent, so never answered: it fails now rather than waiting forever.
				thread.waiting.delete(id);
				clearTimeout(stalled);
				holding(thread);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** Whether a thread takes stores: one that gave its stores up rests a while first. */
	function taking(thread: Thread): boolean {
		if (thread.resting === undefined) return true;
		if (now() - thread.resting < RESTART_WINDOW_MS) return false;
		thread.resting = undefined;
		return true;
	}

	/**
	 * The thread taking stores that holds fewest, passing over one with a
	 * call stalled on it while another can take the store, so a start's
	 * opens don't pile up behind one stalled disk read.
	 */
	function fewest(): Thread {
		let chosen: Thread | undefined;
		const better = (thread: Thread, than: Thread) =>
			thread.stallSaid === than.stallSaid
				? thread.stores.size < than.stores.size
				: !thread.stallSaid;
		for (const thread of threads)
			if (taking(thread) && (!chosen || better(thread, chosen)))
				chosen = thread;
		if (!chosen)
			throw new Error(
				`Every store thread died ${RESTARTS + 1} times in ${RESTART_WINDOW_MS / 60_000} minutes, so no store can be opened`,
			);
		return chosen;
	}

	/** Close a store from now on: a thread that dies under its close doesn't open it again. */
	function closing(thread: Thread, store: number): void {
		const open = thread.stores.get(store);
		if (!open) return;
		thread.stores.delete(store);
		thread.closing.set(store, open);
	}

	function ended(thread: Thread, store: number): void {
		thread.stores.delete(store);
		thread.closing.delete(store);
		givenUp.delete(store);
		if (thread.stores.size > 0 || thread.closing.size > 0 || !thread.worker)
			return;
		const worker = thread.worker;
		thread.worker = undefined;
		// Its last store closed: nothing is left for it to answer.
		failAll(thread, new Error("The store's thread was let go under the call"));
		void worker.terminate();
	}

	return {
		async open(path, storeOptions = {}) {
			const thread = fewest();
			const store = nextStore++;
			const open = {
				op: "open",
				path,
				timeout: storeOptions.busyTimeoutMs ?? BUSY_TIMEOUT_MS,
				pages: storeOptions.walAutoCheckpointPages ?? CHECKPOINT_PAGES,
			} as const;
			thread.stores.set(store, open);
			try {
				await ask(thread, store, open);
			} catch (error) {
				// A thread that died under the open opened it again; this close
				// follows that, so nothing stays open for a store nobody holds.
				closing(thread, store);
				if (thread.worker)
					await ask(thread, store, { op: "close" }).catch(() => {
						// Nothing was open, as when the open itself failed.
					});
				ended(thread, store);
				throw error;
			}
			return storeDatabase({
				ask: (asked, pin) => ask(thread, store, asked, pin),
				moved: (pin) =>
					pin.start !== undefined &&
					(pin.start !== thread.start || !thread.worker),
				closing: () => closing(thread, store),
				ended: () => ended(thread, store),
			});
		},
	};
}

/** Calls run in the order made, each waiting for every one before it. */
function serially(): <T>(operation: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return (operation) => {
		const run = tail.then(operation);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

/** How a store's database reaches its thread. */
interface StoreLink {
	readonly ask: (asked: Asked, pin?: Pin) => Promise<unknown>;
	/** Whether the worker the pin was taken on has ended. */
	readonly moved: (pin: Pin) => boolean;
	/** Close the store from now on, so no new thread opens it again. */
	readonly closing: () => void;
	/** Let the store go, once it has closed. */
	readonly ended: () => void;
}

/** One store's calls through `ask`, each run as `order` runs it. */
function executor(
	ask: (asked: Asked) => Promise<unknown>,
	order: <T>(operation: () => Promise<T>) => Promise<T>,
): StoreExecutor {
	const call = (
		kind: "exec" | "run" | "runCounted" | "get" | "all",
		sql: string,
		params: readonly StoreValue[],
	) => order(() => ask({ op: "call", kind, sql, params }));
	return {
		exec: async (sql) => {
			await call("exec", sql, []);
		},
		run: async (sql, ...params) => {
			await call("run", sql, params);
		},
		runCounted: async (sql, ...params) =>
			Number(await call("runCounted", sql, params)),
		// The thread answers with SQLite's own rows, which are the caller's to type, as chord's adapter leaves them.
		get: async <T extends object>(sql: string, ...params: StoreValue[]) =>
			(await call("get", sql, params)) as T | undefined,
		all: async <T extends object>(sql: string, ...params: StoreValue[]) =>
			(await call("all", sql, params)) as T[],
	};
}

/** A store's database: its calls in order, its transactions holding it, its close ending it. */
function storeDatabase(link: StoreLink): StoreDatabase {
	const { ask, moved, closing, ended } = link;
	const order = serially();
	let closed = false;
	const direct = <T>(operation: () => Promise<T>) => operation();
	return {
		...executor(ask, order),
		transaction(callback) {
			return order(async () => {
				// Every call of it goes to the worker it began on, or is refused.
				const pin: Pin = {};
				const pinned = (asked: Asked) => ask(asked, pin);
				await pinned({
					op: "call",
					kind: "exec",
					sql: "BEGIN IMMEDIATE",
					params: [],
				});
				let active = true;
				const inside = executor(pinned, (operation) => {
					if (!active)
						return Promise.reject(
							new Error("SQLite transaction handle is no longer active"),
						);
					return direct(operation);
				});
				let committing = false;
				try {
					const result = await callback(inside);
					active = false;
					committing = !moved(pin);
					await pinned({
						op: "call",
						kind: "exec",
						sql: "COMMIT",
						params: [],
					});
					return result;
				} catch (error) {
					active = false;
					// The connection it began on went with its thread: SQLite rolled it
					// back, unless the thread ended once its COMMIT had been sent.
					if (moved(pin)) {
						if (!committing) throw error;
						throw new Error(
							"The store's thread ended as its transaction committed, so whether it was written is unknown",
							{ cause: error },
						);
					}
					try {
						await pinned({
							op: "call",
							kind: "exec",
							sql: "ROLLBACK",
							params: [],
						});
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							"SQLite transaction failed and rollback failed",
						);
					}
					throw error;
				}
			});
		},
		close() {
			return order(async () => {
				if (closed) return;
				closed = true;
				closing();
				try {
					await ask({ op: "close" });
				} finally {
					ended();
				}
			});
		},
	};
}
