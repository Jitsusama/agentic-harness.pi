/** The host's checkpointer: a store's log is copied back from another thread, never the one writing it. */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CheckpointEvent,
	type CheckpointOptions,
	type Checkpoints,
	checkpointing,
} from "../../../host/engine/checkpoints.ts";
import { until } from "../../support/until.ts";

/** How often the test's checkpointer looks, in ms: quick, so a pass is quick. */
const EVERY_MS = 20;

/** The log's pages not yet copied back past which the test's checkpointer copies it. */
const PAGES = 8;

/** Rows written, each a page or more, so the log passes PAGES. */
const ROWS = 40;

/** Looks to let go by before taking it that the checkpointer left a store alone. */
const LOOKS = 5;

let dir: string;
let store: string;
let db: DatabaseSync;
let reported: unknown[];
let events: CheckpointEvent[];
let checkpoints: Checkpoints;

/** A checkpointer reporting and observing into this case's own lists. */
function checkpointer(options: CheckpointOptions = {}): Checkpoints {
	// Each case's own lists, so a worker still ending from the last case,
	// its folder gone, says so there and not here.
	const mine = reported;
	const seen = events;
	return checkpointing({
		report: (error) => mine.push(error),
		observe: (event) => seen.push(event),
		every: EVERY_MS,
		pages: PAGES,
		...options,
	});
}

/** The store opened as chord opens one, but with no checkpoint of its own. */
function opened(): DatabaseSync {
	const writer = new DatabaseSync(store);
	writer.exec("PRAGMA journal_mode = WAL");
	writer.exec("PRAGMA synchronous = NORMAL");
	writer.exec("PRAGMA wal_autocheckpoint = 0");
	return writer;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "checkpoints-"));
	store = join(dir, "durable.sqlite");
	db = opened();
	db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, record TEXT)");
	reported = [];
	events = [];
	checkpoints = checkpointer();
});

afterEach(async () => {
	if (db.isOpen) db.close();
	await rm(dir, { recursive: true, force: true });
});

/** Commit ROWS rows of about a page each, as a turn's entries land. */
function commitPages(): void {
	const insert = db.prepare("INSERT INTO entry (record) VALUES (?)");
	for (let row = 0; row < ROWS; row++) insert.run("x".repeat(4096));
}

/** The database file's own size: it grows only as the log is copied back into it. */
function storeSize(): number {
	return statSync(store).size;
}

/** The rows the database file holds by itself, read from a copy with no log beside it. */
function rowsCopiedBack(): number {
	const copy = join(dir, `copy-${events.length}.sqlite`);
	copyFileSync(store, copy);
	const alone = new DatabaseSync(copy, { readOnly: true });
	try {
		const row = alone.prepare("SELECT count(*) AS n FROM entry").get();
		return Number(row?.n);
	} finally {
		alone.close();
	}
}

/** How many checkpoints the worker has made of the store. */
function checkpointsMade(): number {
	return events.filter(({ op }) => op === "checkpointed").length;
}

/** Where the kernel lists every POSIX lock, on Linux. */
const LOCKS = "/proc/locks";

/** How many POSIX locks this process holds on the store's WAL index. */
function locksOnIndex(): number {
	const inode = statSync(`${store}-shm`).ino;
	return readFileSync(LOCKS, "utf8")
		.split("\n")
		.filter((line) => {
			const fields = line.trim().split(/\s+/);
			// "1: POSIX ADVISORY READ <pid> <major>:<minor>:<inode> <start> <end>"
			return (
				fields[1] === "POSIX" &&
				fields[4] === String(process.pid) &&
				fields[5]?.endsWith(`:${inode}`)
			);
		}).length;
}

/** Wait until the worker has looked `looks` more times. */
async function looksGoBy(looks: number): Promise<void> {
	const looked = () => events.filter(({ op }) => op === "looked").length;
	const target = looked() + looks;
	await until(`${looks} more looks`, () => looked() >= target);
}

describe("the host's checkpointer", () => {
	it("copies a kept store's log back once it passes its pages, once rather than at each look, while the writer never does", async () => {
		const before = storeSize();
		commitPages();
		// The writer has no checkpoint, so only the checkpointer grows the database itself.
		expect(storeSize()).toBe(before);

		const kept = checkpoints.keep(store);
		await until("the store's log copied back off the thread", () =>
			events.some(({ op }) => op === "checkpointed"),
		);
		expect(rowsCopiedBack(), "every row is in the database file").toBe(ROWS);
		// The log file keeps its length after a PASSIVE checkpoint; what is left to copy is none.
		await looksGoBy(LOOKS);
		expect(checkpointsMade()).toBe(1);
		kept.release();
		expect(reported).toEqual([]);
	});

	it.skipIf(!existsSync(LOCKS))(
		"keeps SQLite's locks on a store's WAL index while it looks, so another process can't take the store for unopened",
		async () => {
			db.prepare("INSERT INTO entry (record) VALUES (?)").run("x");
			const held = locksOnIndex();
			expect(held, "the writer's own lock").toBeGreaterThan(0);

			const kept = checkpoints.keep(store);
			await looksGoBy(LOOKS);
			expect(locksOnIndex(), "while it looks").toBeGreaterThanOrEqual(held);

			// Released while the writer stays open, as a conversation opening the
			// store before the worker has read the release would be; a worker
			// that exits closes what it opened, so this waits for that too.
			kept.release();
			await until("the worker ended with its last store", () =>
				events.some(({ op }) => op === "ended"),
			);
			expect(
				locksOnIndex(),
				"once its worker has ended",
			).toBeGreaterThanOrEqual(held);
			const again = checkpoints.keep(store);
			await looksGoBy(LOOKS);
			expect(locksOnIndex(), "kept again").toBeGreaterThanOrEqual(held);
			again.release();
		},
	);

	it("follows a store's WAL index that SQLite made afresh, kept again before the writer is back", async () => {
		const kept = checkpoints.keep(store);
		await looksGoBy(1);
		const first = statSync(`${store}-shm`).ino;
		db.close();
		kept.release();
		await until(
			"the index gone with the last connection",
			() => !existsSync(`${store}-shm`),
		);

		// Kept while it has no index, so the worker asks for one once it has.
		const again = checkpoints.keep(store);
		db = opened();
		commitPages();
		expect(statSync(`${store}-shm`).ino, "a new index").not.toBe(first);
		await until("the store checkpointed through its new index", () =>
			events.some(({ op }) => op === "checkpointed"),
		);
		again.release();
		expect(reported).toEqual([]);
	});

	it.skipIf(!existsSync(LOCKS))(
		"keeps a store all the same when a FIFO sits where its index belongs, never waiting on it",
		async () => {
			db.close();
			await until(
				"the index gone with the last connection",
				() => !existsSync(`${store}-shm`),
			);
			execFileSync("mkfifo", [`${store}-shm`]);

			// A blocking open here would hold this thread, and the case, for good.
			const kept = checkpoints.keep(store);
			await looksGoBy(LOOKS);
			expect(checkpointsMade()).toBe(0);
			kept.release();
		},
	);

	it("leaves a log short of its pages alone", async () => {
		db.prepare("INSERT INTO entry (record) VALUES (?)").run("x");
		const before = storeSize();
		const kept = checkpoints.keep(store);
		await looksGoBy(LOOKS);
		expect(checkpointsMade()).toBe(0);
		expect(storeSize()).toBe(before);
		kept.release();
	});

	it("copies even a short log back as the store closes, and leaves no log once both have closed", async () => {
		// Never looks by itself in the case's time, so only the close copies.
		const quiet = checkpointer({ every: 60_000 });
		const kept = quiet.keep(store);
		db.prepare("INSERT INTO entry (record) VALUES (?)").run("x");
		await kept.settle();
		expect(rowsCopiedBack()).toBe(1);
		db.close();
		kept.release();
		await until(
			"the log gone with the last connection",
			() => !existsSync(`${store}-wal`),
		);
		expect(reported).toEqual([]);
	});

	it("keeps a store two conversations keep until both let it go, each letting go only of its own", async () => {
		const first = checkpoints.keep(store);
		const second = checkpoints.keep(store);
		first.release();
		first.release();
		commitPages();
		await until("the store still checkpointed for the second", () =>
			events.some(({ op }) => op === "checkpointed"),
		);
		second.release();
		expect(reported).toEqual([]);
	});

	it("keeps a store again once its last keep has let it go", async () => {
		checkpoints.keep(store).release();
		const again = checkpoints.keep(store);
		commitPages();
		await until("the store checkpointed by the worker started again", () =>
			events.some(({ op }) => op === "checkpointed"),
		);
		again.release();
		expect(reported).toEqual([]);
	});

	it("closes all the same, saying so, when its checkpoint doesn't settle in time", async () => {
		const hasty = checkpointer({ settleWithin: 0 });
		const kept = hasty.keep(store);
		await kept.settle();
		kept.release();
		expect(String(reported[0])).toContain(
			`Closing ${store} without its checkpoint, which didn't settle in 0 s`,
		);
	});

	it("says when it can't keep a store, and a close waiting on it still settles", async () => {
		const folder = join(dir, "not-a-store");
		await mkdir(folder);
		const kept = checkpoints.keep(folder);
		await kept.settle();
		kept.release();
		expect(String(reported[0])).toContain(
			`Couldn't checkpoint ${folder} off the thread`,
		);
	});

	it("never makes a store that is gone", async () => {
		const gone = join(dir, "gone.sqlite");
		const kept = checkpoints.keep(gone);
		await kept.settle();
		kept.release();
		expect(existsSync(gone), "no store made where one was gone").toBe(false);
		expect(String(reported[0])).toContain("the store is gone");
	});
});
