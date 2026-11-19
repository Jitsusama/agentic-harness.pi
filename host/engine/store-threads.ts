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
 * each of its stores opened anew, at most a few times; SQLite rolls back a
 * transaction its connection took with it. After that, its stores refuse.
 */

import { Worker } from "node:worker_threads";

/** How many threads the stores are spread across. */
const THREADS = 4;

/** How long a store waits for a competing lock, in ms: chord's own default. */
const BUSY_TIMEOUT_MS = 5000;

/** SQLite's own checkpoint threshold, in pages, for a store nothing else checkpoints. */
const CHECKPOINT_PAGES = 1000;

/** How many times a thread that died is started again before its stores refuse. */
const RESTARTS = 3;

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
	if (message.op === "open") return opened(message);
	const store = stores.get(message.store);
	if (!store) throw new Error("The store isn't open on its thread");
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

/** One worker thread and the stores it holds. */
interface Thread {
	worker: Worker | undefined;
	restarts: number;
	/** Each store it holds, by key, with how to open it again. */
	readonly stores: Map<number, Extract<Asked, { op: "open" }>>;
	/** Each call it was asked and hasn't answered. */
	readonly waiting: Map<
		number,
		{
			readonly resolve: (value: unknown) => void;
			readonly reject: (error: Error) => void;
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
			restarts: 0,
			stores: new Map(),
			waiting: new Map(),
		}),
	);
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
		for (const one of waiting) one.reject(error);
	}

	function started(thread: Thread): Worker {
		if (thread.worker) return thread.worker;
		const worker = new Worker(PROGRAM, { eval: true });
		worker.unref();
		worker.on("message", (message: unknown) => {
			if (!isAnswer(message)) return;
			const one = thread.waiting.get(message.id);
			if (!one) return;
			thread.waiting.delete(message.id);
			holding(thread);
			if (message.error) one.reject(errorFrom(message.error));
			else one.resolve(message.value);
		});
		worker.on("error", (error: unknown) => {
			const said = error instanceof Error ? error.message : String(error);
			report(new Error(`A store thread failed: ${said}`));
		});
		worker.on("exit", () => {
			if (thread.worker !== worker) return;
			thread.worker = undefined;
			failAll(thread, new Error("The store's thread ended under the call"));
			if (thread.stores.size === 0) return;
			if (thread.restarts >= RESTARTS) {
				report(
					new Error(
						`A store thread died ${RESTARTS + 1} times; its ${thread.stores.size} stores refuse every call`,
					),
				);
				return;
			}
			thread.restarts++;
			// Opened anew, in the order they were first opened; a call that fails says so itself.
			for (const [store, open] of thread.stores)
				ask(thread, store, open).catch(report);
		});
		thread.worker = worker;
		return worker;
	}

	function ask(thread: Thread, store: number, asked: Asked): Promise<unknown> {
		if (!thread.worker && thread.restarts >= RESTARTS)
			return Promise.reject(new Error("The store's thread is gone"));
		const worker = started(thread);
		const id = nextId++;
		return new Promise((resolve, reject) => {
			thread.waiting.set(id, { resolve, reject });
			holding(thread);
			worker.postMessage({ ...asked, id, store });
		});
	}

	function fewest(): Thread {
		let chosen = threads[0];
		for (const thread of threads)
			if (chosen && thread.stores.size < chosen.stores.size) chosen = thread;
		if (!chosen) throw new Error("The host has no store threads");
		return chosen;
	}

	function ended(thread: Thread, store: number): void {
		thread.stores.delete(store);
		if (thread.stores.size > 0 || !thread.worker) return;
		const worker = thread.worker;
		thread.worker = undefined;
		// Its last store closed: nothing is left for it to answer.
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
				ended(thread, store);
				throw error;
			}
			return storeDatabase(
				(asked) => ask(thread, store, asked),
				() => ended(thread, store),
			);
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

/** One store's calls through `ask`, live while `live` says so. */
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
function storeDatabase(
	ask: (asked: Asked) => Promise<unknown>,
	ended: () => void,
): StoreDatabase {
	const order = serially();
	let closed = false;
	const direct = <T>(operation: () => Promise<T>) => operation();
	return {
		...executor(ask, order),
		transaction(callback) {
			return order(async () => {
				await ask({
					op: "call",
					kind: "exec",
					sql: "BEGIN IMMEDIATE",
					params: [],
				});
				let active = true;
				const inside = executor(ask, (operation) => {
					if (!active)
						return Promise.reject(
							new Error("SQLite transaction handle is no longer active"),
						);
					return direct(operation);
				});
				try {
					const result = await callback(inside);
					active = false;
					await ask({ op: "call", kind: "exec", sql: "COMMIT", params: [] });
					return result;
				} catch (error) {
					active = false;
					try {
						await ask({
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
				try {
					await ask({ op: "close" });
				} finally {
					ended();
				}
			});
		},
	};
}
