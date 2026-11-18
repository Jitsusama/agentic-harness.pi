/** The host's checkpointer: a store's log is copied back from another thread, never the one writing it. */
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Checkpoints,
	checkpointing,
} from "../../../host/engine/checkpoints.ts";
import { until } from "../../support/until.ts";

/** How often the test's checkpointer looks, in ms: quick, so a pass is quick. */
const EVERY_MS = 20;

/** The log's length in pages past which the test's checkpointer copies it back. */
const PAGES = 8;

/** Rows written, each a page or more, so the log passes PAGES. */
const ROWS = 40;

let dir: string;
let store: string;
let db: DatabaseSync;
let reported: unknown[];
let checkpoints: Checkpoints;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "checkpoints-"));
	store = join(dir, "durable.sqlite");
	// Opened as chord opens a store, but with no checkpoint of its own.
	db = new DatabaseSync(store);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA wal_autocheckpoint = 0");
	db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, record TEXT)");
	// Each case's own list, so a worker still ending from the last case,
	// its folder gone, reports there and not here.
	const mine: unknown[] = [];
	reported = mine;
	checkpoints = checkpointing({
		report: (error) => mine.push(error),
		every: EVERY_MS,
		pages: PAGES,
	});
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

describe("the host's checkpointer", () => {
	it("copies a kept store's log back once it passes its pages, while the writer never does", async () => {
		const kept = checkpoints.keep(store);
		const before = statSync(store).size;
		commitPages();
		// The writer has no checkpoint, so only the checkpointer grows the database itself.
		expect(statSync(store).size).toBe(before);
		await until(
			"the store's log copied back off the thread",
			() => storeSize() > before,
		);
		kept.release();
		// Copied, not lost: every row still reads back.
		const row = db.prepare("SELECT count(*) AS n FROM entry").get();
		expect(row?.n).toBe(ROWS);
		expect(reported).toEqual([]);
	});

	it("leaves a log short of its pages alone", async () => {
		const kept = checkpoints.keep(store);
		const before = statSync(store).size;
		db.prepare("INSERT INTO entry (record) VALUES (?)").run("x");
		await new Promise((resolve) => setTimeout(resolve, EVERY_MS * 5));
		expect(statSync(store).size).toBe(before);
		kept.release();
	});

	it("copies the log back as the store closes, whatever its length, so its close finds none", async () => {
		const mine = reported;
		const quiet = checkpointing({
			report: (error) => mine.push(error),
			// Never looks by itself in the case's time, so only the close copies.
			every: 60_000,
			pages: PAGES,
		});
		const kept = quiet.keep(store);
		const before = statSync(store).size;
		commitPages();
		await kept.settle();
		expect(statSync(store).size).toBeGreaterThan(before);
		db.close();
		kept.release();
		expect(reported).toEqual([]);
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
});
