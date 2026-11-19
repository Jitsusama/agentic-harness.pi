/** The host's stores, read and written on threads of their own, as chord's SqliteDatabase promises. */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type StoreDatabase,
	type StoreThreads,
	storeThreads,
} from "../../../host/engine/store-threads.ts";

/** How long a store waits for a lock another connection holds, in ms, in the stall case. */
const STALL_MS = 1500;

/** How often the host's thread ticks while a store is stalled, in ms. */
const TICK_MS = 50;

/** Store threads whose workers this case keeps, to end one under its stores. */
function keptThreads(threads = 1): {
	readonly threads: StoreThreads;
	readonly workers: Worker[];
	readonly reported: unknown[];
} {
	const workers: Worker[] = [];
	const kept: unknown[] = [];
	return {
		threads: storeThreads({
			threads,
			report: (error) => kept.push(error),
			worker: (program) => {
				const worker = new Worker(program, { eval: true });
				workers.push(worker);
				return worker;
			},
		}),
		workers,
		reported: kept,
	};
}

/** End a thread's newest worker, as a crash would, once it has gone. */
async function kill(workers: readonly Worker[]): Promise<void> {
	const worker = workers.at(-1);
	if (!worker) throw new Error("No worker to end");
	await worker.terminate();
}

/** Once the worker has ended, at once if it has already. */
function exited(worker: Worker | undefined): Promise<unknown> {
	if (!worker) throw new Error("No worker to wait on");
	if (worker.threadId === -1) return Promise.resolve();
	return new Promise((done) => worker.once("exit", done));
}

let dir: string;
let reported: unknown[];
let threads: StoreThreads;
let opened: StoreDatabase[];

/** Open a store in this case's folder, closed after it. */
async function store(
	name = "durable.sqlite",
	options?: Parameters<StoreThreads["open"]>[1],
): Promise<StoreDatabase> {
	const database = await threads.open(join(dir, name), options);
	opened.push(database);
	return database;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "store-threads-"));
	reported = [];
	opened = [];
	const mine = reported;
	threads = storeThreads({ report: (error) => mine.push(error) });
});

afterEach(async () => {
	await Promise.allSettled(opened.map((database) => database.close()));
	await rm(dir, { recursive: true, force: true });
	expect(reported).toEqual([]);
});

describe("a store on its own thread", () => {
	it("reads back what it wrote, every value SQLite holds", async () => {
		const db = await store();
		await db.exec(
			"CREATE TABLE entry (id INTEGER PRIMARY KEY, text TEXT, real REAL, blob BLOB, none TEXT)",
		);
		await db.run(
			"INSERT INTO entry (text, real, blob, none) VALUES (?, ?, ?, ?)",
			"a",
			1.5,
			new Uint8Array([1, 2, 3]),
			null,
		);
		expect(await db.get("SELECT * FROM entry WHERE id = ?", 1)).toEqual({
			id: 1,
			text: "a",
			real: 1.5,
			blob: new Uint8Array([1, 2, 3]),
			none: null,
		});
		expect(await db.get("SELECT * FROM entry WHERE id = ?", 2)).toBeUndefined();
		expect(await db.runCounted("UPDATE entry SET text = ?", "b")).toBe(1);
		expect(await db.all("SELECT text FROM entry")).toEqual([{ text: "b" }]);
	});

	it("is set up as chord sets a store up, with the checkpoint pages it's given", async () => {
		const db = await store("kept.sqlite", { walAutoCheckpointPages: 0 });
		expect(await db.get("PRAGMA journal_mode")).toEqual({
			journal_mode: "wal",
		});
		expect(await db.get("PRAGMA synchronous")).toEqual({ synchronous: 1 });
		expect(await db.get("PRAGMA wal_autocheckpoint")).toEqual({
			wal_autocheckpoint: 0,
		});
		const plain = await store("plain.sqlite");
		expect(await plain.get("PRAGMA wal_autocheckpoint")).toEqual({
			wal_autocheckpoint: 1000,
		});
	});

	it("says SQLite's own error, with its code", async () => {
		const db = await store();
		const failed = await db
			.exec("SELECT * FROM missing")
			.catch((error) => error);
		expect(failed).toBeInstanceOf(Error);
		expect(failed.message).toMatch(/no such table: missing/);
		expect(failed.code).toBe("ERR_SQLITE_ERROR");
	});

	it("leaves the host's thread free while its BEGIN waits on another's write lock", async () => {
		const path = join(dir, "durable.sqlite");
		const db = await store("durable.sqlite", { busyTimeoutMs: STALL_MS });
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		// Another connection takes the write lock, so the store's own BEGIN waits its busy timeout out.
		const other = new DatabaseSync(path);
		other.exec("BEGIN IMMEDIATE");
		let ticks = 0;
		const ticking = setInterval(() => ticks++, TICK_MS);
		const started = performance.now();
		try {
			const waited = await db
				.transaction(async () => undefined)
				.catch((error) => error);
			expect(waited.message).toMatch(/database is locked/);
			const took = performance.now() - started;
			expect(took).toBeGreaterThan(STALL_MS / 2);
			// On the host's thread, the wait would leave no tick at all.
			expect(ticks).toBeGreaterThan(took / TICK_MS / 3);
		} finally {
			clearInterval(ticking);
			other.exec("ROLLBACK");
			other.close();
		}
	});

	it("checkpoints its log away as it closes", async () => {
		const path = join(dir, "durable.sqlite");
		const db = await threads.open(path, { walAutoCheckpointPages: 0 });
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, text TEXT)");
		// Another connection stays open and has read the log's index, so SQLite's own last close can't remove the log.
		const other = new DatabaseSync(path);
		other.prepare("SELECT count(*) FROM entry").get();
		try {
			for (let row = 0; row < 20; row++)
				await db.run("INSERT INTO entry (text) VALUES (?)", "x".repeat(4096));
			expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
			await db.close();
			expect(statSync(`${path}-wal`).size).toBe(0);
		} finally {
			other.close();
		}
		expect(
			!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0,
		).toBe(true);
		// Closed twice is closed once.
		await db.close();
	});

	it("refuses a call once closed, starting no thread for it", async () => {
		const kept = keptThreads();
		const db = await kept.threads.open(join(dir, "durable.sqlite"));
		await db.close();
		await expect(db.get("SELECT 1 AS one")).rejects.toThrow(/closed/);
		expect(kept.workers).toHaveLength(1);
	});

	it("says a call that has waited long on its thread, once, and still answers it", async () => {
		const said: unknown[] = [];
		const slow = storeThreads({
			threads: 1,
			stalledMs: STALL_MS / 3,
			report: (error) => said.push(error),
		});
		const path = join(dir, "durable.sqlite");
		const db = await slow.open(path, { busyTimeoutMs: STALL_MS });
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		const other = new DatabaseSync(path);
		other.exec("BEGIN IMMEDIATE");
		try {
			await expect(db.transaction(async () => undefined)).rejects.toThrow(
				/database is locked/,
			);
		} finally {
			other.exec("ROLLBACK");
			other.close();
			await db.close();
		}
		expect(said).toHaveLength(1);
		expect(String(said[0])).toMatch(/has waited 0\.5 s on its thread/);
	});
});

describe("a store whose thread dies", () => {
	it("fails the call it held, then answers again on a thread started anew, its rows kept", async () => {
		const kept = keptThreads();
		const db = await kept.threads.open(join(dir, "durable.sqlite"));
		opened.push(db);
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		await db.run("INSERT INTO entry (id) VALUES (?)", 1);
		// Long enough that its answer can't come before the thread ends.
		const held = db.get(
			"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*) AS n FROM c",
		);
		await kill(kept.workers);
		await expect(held).rejects.toThrow(/ended under the call/);
		expect(await db.all("SELECT id FROM entry")).toEqual([{ id: 1 }]);
		expect(kept.workers).toHaveLength(2);
		expect(kept.reported).toEqual([]);
	});

	it("refuses the rest of a transaction it took, and writes none of it", async () => {
		const kept = keptThreads();
		const db = await kept.threads.open(join(dir, "durable.sqlite"));
		opened.push(db);
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		const failed = await db
			.transaction(async (transaction) => {
				await transaction.run("INSERT INTO entry (id) VALUES (?)", 1);
				await kill(kept.workers);
				await transaction.run("INSERT INTO entry (id) VALUES (?)", 2);
			})
			.catch((error) => error);
		expect(failed.message).toMatch(/started again under its transaction/);
		expect(await db.all("SELECT id FROM entry")).toEqual([]);
	});

	it("is started again three times, and past that its stores refuse and new ones go elsewhere", async () => {
		const kept = keptThreads(2);
		const db = await kept.threads.open(join(dir, "dying.sqlite"));
		opened.push(db);
		const dying = kept.workers.length - 1;
		for (let restart = 1; restart <= 3; restart++) {
			await kept.workers.at(-1)?.terminate();
			expect(await db.get("SELECT 1 AS one")).toEqual({ one: 1 });
		}
		expect(kept.workers.length - dying).toBe(4);
		await kept.workers.at(-1)?.terminate();
		await expect(db.get("SELECT 1 AS one")).rejects.toThrow(/thread is gone/);
		expect(String(kept.reported)).toMatch(/died 4 times/);
		const after = await kept.threads.open(join(dir, "after.sqlite"));
		opened.push(after);
		expect(await after.get("SELECT 1 AS one")).toEqual({ one: 1 });
	});

	it("leaves nothing open for a store whose open it ended", async () => {
		const kept = keptThreads();
		const first = await kept.threads.open(join(dir, "first.sqlite"));
		opened.push(first);
		const second = join(dir, "second.sqlite");
		const opening = kept.threads.open(second);
		await kill(kept.workers);
		await expect(opening).rejects.toThrow(/ended under the call/);
		// An open connection keeps its log and shared memory; SQLite removes both at the last close.
		expect(existsSync(`${second}-wal`) || existsSync(`${second}-shm`)).toBe(
			false,
		);
		expect(await first.get("SELECT 1 AS one")).toEqual({ one: 1 });
		expect(kept.reported).toEqual([]);
	});
});

describe("a store's transactions, as chord's contract has them", () => {
	it("commits what its callback wrote, and answers with what the callback did", async () => {
		const db = await store();
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		const answered = await db.transaction(async (transaction) => {
			await transaction.run("INSERT INTO entry (id) VALUES (?)", 1);
			return (
				await transaction.get<{ n: number }>("SELECT count(*) AS n FROM entry")
			)?.n;
		});
		expect(answered).toBe(1);
		expect(await db.all("SELECT id FROM entry")).toEqual([{ id: 1 }]);
	});

	it("rolls back when its callback rejects, rejecting with the callback's error", async () => {
		const db = await store();
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		const refused = new Error("refused");
		const failed = await db
			.transaction(async (transaction) => {
				await transaction.run("INSERT INTO entry (id) VALUES (?)", 1);
				throw refused;
			})
			.catch((error) => error);
		expect(failed).toBe(refused);
		expect(await db.all("SELECT id FROM entry")).toEqual([]);
	});

	it("rejects with an AggregateError when the rollback fails too", async () => {
		const db = await store();
		const failed = await db
			.transaction(async (transaction) => {
				// Ended inside, so the rollback finds no transaction to roll back.
				await transaction.exec("COMMIT");
				throw new Error("refused");
			})
			.catch((error) => error);
		expect(failed).toBeInstanceOf(AggregateError);
		expect(failed.errors[0].message).toBe("refused");
	});

	it("refuses a handle once its transaction has settled", async () => {
		const db = await store();
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		let kept:
			| Parameters<Parameters<StoreDatabase["transaction"]>[0]>[0]
			| undefined;
		await db.transaction(async (transaction) => {
			kept = transaction;
		});
		await expect(
			kept?.run("INSERT INTO entry (id) VALUES (?)", 1),
		).rejects.toThrow(/no longer active/);
	});

	it("holds the store's other calls until it ends, and runs them in the order made", async () => {
		const db = await store();
		await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
		const seen: string[] = [];
		let resolve = (): void => {};
		const release = new Promise<void>((done) => {
			resolve = done;
		});
		const inside = db.transaction(async (transaction) => {
			await transaction.run("INSERT INTO entry (id) VALUES (?)", 1);
			await release;
			seen.push("committing");
		});
		const after = db.all("SELECT id FROM entry").then((rows) => {
			seen.push(`read ${rows.length}`);
		});
		const later = db.run("INSERT INTO entry (id) VALUES (?)", 2).then(() => {
			seen.push("wrote 2");
		});
		// Long enough for a call that didn't wait to have been answered.
		await new Promise((done) => setTimeout(done, 100));
		expect(seen).toEqual([]);
		resolve();
		await Promise.all([inside, after, later]);
		expect(seen).toEqual(["committing", "read 1", "wrote 2"]);
	});
});

describe("the threads the stores are spread across", () => {
	it("spreads stores by how many each thread holds, so a stalled store holds only those beside it", async () => {
		const spread = storeThreads({ threads: 2 });
		const stalled = await spread.open(join(dir, "stalled.sqlite"), {
			busyTimeoutMs: STALL_MS,
		});
		const free = await spread.open(join(dir, "free.sqlite"));
		try {
			await stalled.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY)");
			const other = new DatabaseSync(join(dir, "stalled.sqlite"));
			other.exec("BEGIN IMMEDIATE");
			try {
				const waiting = stalled
					.transaction(async () => undefined)
					.catch(() => {});
				const started = performance.now();
				await free.get("SELECT 1 AS one");
				expect(performance.now() - started).toBeLessThan(STALL_MS / 2);
				await waiting;
			} finally {
				other.exec("ROLLBACK");
				other.close();
			}
		} finally {
			await Promise.allSettled([stalled.close(), free.close()]);
		}
	});

	it("opens nothing for a store that can't be opened, and says why", async () => {
		const kept = keptThreads();
		await expect(
			kept.threads.open(join(dir, "no-folder", "durable.sqlite")),
		).rejects.toThrow(/unable to open database file/);
		// It held no other store, so its thread ends.
		await exited(kept.workers[0]);
		expect(kept.reported).toEqual([]);
	});
});
