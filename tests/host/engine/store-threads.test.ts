/** The host's stores, read and written on threads of their own, as chord's SqliteDatabase promises. */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

	it("leaves the host's thread free while a read waits on a lock", async () => {
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
		for (let row = 0; row < 20; row++)
			await db.run("INSERT INTO entry (text) VALUES (?)", "x".repeat(4096));
		expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
		await db.close();
		expect(
			!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0,
		).toBe(true);
		// Closed twice is closed once.
		await db.close();
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
		await expect(
			threads.open(join(dir, "no-folder", "durable.sqlite")),
		).rejects.toThrow(/unable to open database file/);
	});
});
