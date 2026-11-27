/** A heap snapshot of a conversation's process: where, how private, and when refused. */
import { statSync, writeFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotHeap } from "../../../host/service/heap-snapshot.ts";

const ONE = "01a1cf4a-a681-7237-bce7-2ce6dbc70547";
const AT = new Date("2026-11-27T08:00:00.000Z");
const OWNER_ONLY_FOLDER = 0o700;
const OWNER_ONLY_FILE = 0o600;
const PERMISSIONS = 0o777;
const MIB = 1024 * 1024;
/** Enough of a snapshot to see it opens as V8's format does. */
const OPENING_BYTES = 64;

let dir: string;
let folder: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "heap-snapshot-"));
	folder = join(dir, "state", "heap-snapshots");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A clock that reads `first`, then `first + ms`, as a write that took `ms`. */
function clockTaking(ms: number, first = 1000): () => number {
	let reads = 0;
	return () => first + (reads++ === 0 ? 0 : ms);
}

describe("a heap snapshot", () => {
	it("is written to a file named by the conversation and the time, and answered with its size and pause", () => {
		const said: string[] = [];
		const modes: number[] = [];
		const answer = snapshotHeap(ONE, "idle", {
			folder,
			now: () => AT,
			clock: clockTaking(2400),
			say: (line) => said.push(line),
			write: (file) => {
				// What another reader would find while V8 writes into it.
				modes.push(statSync(file).mode & PERMISSIONS);
				writeFileSync(file, Buffer.alloc(3 * MIB));
			},
		});

		expect(answer).toStrictEqual({
			sessionId: ONE,
			file: join(folder, `${ONE}-2026-11-27T08-00-00.000Z.heapsnapshot`),
			bytes: 3 * MIB,
			tookMs: 2400,
		});
		expect(modes, "owner-only before V8 writes a byte").toEqual([
			OWNER_ONLY_FILE,
		]);
		expect(said).toEqual([
			`Wrote a heap snapshot of conversation ${ONE}'s process, 3 MiB, to ${answer.file}; its thread stopped for 2400 ms`,
		]);
	});

	it("keeps the file and its folder for the owner alone, a folder already there too", async () => {
		await mkdir(folder, { recursive: true, mode: 0o755 });
		const { file } = snapshotHeap(ONE, "idle", {
			folder,
			write: () => undefined,
		});

		expect((await stat(folder)).mode & PERMISSIONS).toBe(OWNER_ONLY_FOLDER);
		expect((await stat(file)).mode & PERMISSIONS).toBe(OWNER_ONLY_FILE);
	});

	it("is refused while its conversation is busy, writing nothing", async () => {
		let wrote = false;
		expect(() =>
			snapshotHeap(ONE, "busy", {
				folder,
				write: () => {
					wrote = true;
				},
			}),
		).toThrow("is busy, and a heap snapshot stops its thread");
		expect(wrote, "V8 never asked to write").toBe(false);
		await expect(readdir(folder), "no folder made either").rejects.toThrow();
	});

	it("never writes over a file already there under its name", async () => {
		await mkdir(folder, { recursive: true });
		const file = join(folder, `${ONE}-2026-11-27T08-00-00.000Z.heapsnapshot`);
		await writeFile(file, "kept");

		expect(() =>
			snapshotHeap(ONE, "idle", {
				folder,
				now: () => AT,
				write: () => undefined,
			}),
		).toThrow("EEXIST");
	});

	it("is V8's own snapshot unless told how to write one, into the file made for it", async () => {
		const { file, bytes } = snapshotHeap(ONE, "idle", { folder });

		expect(bytes, "a whole process's heap").toBeGreaterThan(MIB);
		expect((await stat(file)).mode & PERMISSIONS, "V8 kept its mode").toBe(
			OWNER_ONLY_FILE,
		);
		const handle = await open(file);
		const opening = Buffer.alloc(OPENING_BYTES);
		await handle.read(opening, 0, OPENING_BYTES, 0);
		await handle.close();
		expect(opening.toString("utf8"), "a V8 heap snapshot").toMatch(
			/^\{\s*"snapshot":\s*\{\s*"meta"/,
		);
	});
});
