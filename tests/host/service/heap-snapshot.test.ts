/** A heap snapshot of a conversation's process: where, how private, its summary, its sweep and when refused. */
import { statSync, writeFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RAW_FOLDER,
	SNAPSHOT_KEPT_MS,
	snapshotHeap,
} from "../../../host/service/heap-snapshot.ts";
import {
	type HeapSummary,
	parseHeapSummary,
	writeSummary,
} from "../../../host/service/heap-summary.ts";

const ONE = "01a1cf4a-a681-7237-bce7-2ce6dbc70547";
const AT = new Date("2026-11-27T08:00:00.000Z");
const OWNER_ONLY_FOLDER = 0o700;
const OWNER_ONLY_FILE = 0o600;
const PERMISSIONS = 0o777;
const MIB = 1024 * 1024;
/** Enough of a snapshot to see it opens as V8's format does. */
const OPENING_BYTES = 64;
/** A whole process's heap written by V8 itself, on a busy machine. */
const REAL_WRITE_MS = 60_000;
const MS_PER_MINUTE = 60_000;
const STAMP = "2026-11-27T08-00-00.000Z";
/** A summary as a sum would write one. */
const FIGURES: HeapSummary = {
	nodes: 3,
	selfSize: 96,
	byType: [{ type: "object", count: 3, selfSize: 96 }],
	byTypeAndName: [{ type: "object", name: "Thing", count: 3, selfSize: 96 }],
	largeStrings: { atLeast: 65_536, count: 0, selfSize: 0 },
};
/** A sum that writes FIGURES as the summing process would, in this one. */
const summed = {
	sum: (_raw: string, into: string) => {
		writeSummary(FIGURES, into);
		return Promise.resolve();
	},
};

let dir: string;
let folder: string;
let raws: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "heap-snapshot-"));
	folder = join(dir, "state", "heap-snapshots");
	raws = join(folder, RAW_FOLDER);
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
	it("is written to a file named by the conversation and the time, and answered with its size, its pause and who asked", () => {
		const said: string[] = [];
		const modes: number[] = [];
		const answer = snapshotHeap(ONE, "idle", "scripts/host-memory.ts", {
			...summed,
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
			file: join(raws, `${ONE}-${STAMP}.heapsnapshot`),
			summary: join(folder, `${ONE}-${STAMP}.summary.json`),
			bytes: 3 * MIB,
			tookMs: 2400,
		});
		expect(modes, "owner-only before V8 writes a byte").toEqual([
			OWNER_ONLY_FILE,
		]);
		expect(said).toEqual([
			`Wrote a heap snapshot of conversation ${ONE}'s process, 3 MiB, to ${answer.file}, asked by scripts/host-memory.ts over the control socket; its thread stopped for 2400 ms`,
		]);
	});

	it("is written for an asker that didn't name itself, the journal saying so", () => {
		const said: string[] = [];
		const answer = snapshotHeap(ONE, "idle", undefined, {
			...summed,
			folder,
			clock: clockTaking(10),
			say: (line) => said.push(line),
			write: () => undefined,
		});

		expect(said).toEqual([
			`Wrote a heap snapshot of conversation ${ONE}'s process, 0 MiB, to ${answer.file}, asked by a control request that didn't say who sent it; its thread stopped for 10 ms`,
		]);
	});

	it("names its asker on one plain line, whatever the name holds", () => {
		const said: string[] = [];
		snapshotHeap(ONE, "idle", "one\nWrote a heap snapshot\u001b[2J", {
			...summed,
			folder,
			say: (line) => said.push(line),
			write: () => undefined,
		});

		expect(said[0]).toContain(
			"asked by one Wrote a heap snapshot [2J over the control socket",
		);
	});

	it("keeps the raw file in a hidden folder, it and both folders for the owner alone, folders already there too", async () => {
		await mkdir(raws, { recursive: true, mode: 0o755 });
		await mkdir(folder, { recursive: true, mode: 0o755 });
		const { file } = snapshotHeap(ONE, "idle", undefined, {
			...summed,
			folder,
			write: () => undefined,
		});

		expect(file.startsWith(`${raws}/`), "in the hidden folder").toBe(true);
		expect((await stat(folder)).mode & PERMISSIONS).toBe(OWNER_ONLY_FOLDER);
		expect((await stat(raws)).mode & PERMISSIONS).toBe(OWNER_ONLY_FOLDER);
		expect((await stat(file)).mode & PERMISSIONS).toBe(OWNER_ONLY_FILE);
	});

	it("is summed into an owner-only summary beside the hidden folder, the journal saying when and how long", async () => {
		const said: string[] = [];
		const asked: string[][] = [];
		const { file, summary } = snapshotHeap(ONE, "idle", undefined, {
			folder,
			now: () => AT,
			clock: clockTaking(900),
			say: (line) => said.push(line),
			write: () => undefined,
			sum: (raw, into) => {
				asked.push([raw, into]);
				return summed.sum(raw, into);
			},
		});

		await vi.waitFor(() => expect(said).toHaveLength(2));
		expect(asked).toEqual([[file, summary]]);
		expect(summary).toBe(join(folder, `${ONE}-${STAMP}.summary.json`));
		expect((await stat(summary)).mode & PERMISSIONS).toBe(OWNER_ONLY_FILE);
		expect(
			parseHeapSummary(JSON.parse(await readFile(summary, "utf8"))),
		).toEqual(FIGURES);
		expect(said[1]).toBe(
			`Summed heap snapshot ${file} into ${summary} in 0 ms`,
		);
	});

	it("keeps the raw file when its sum fails, the journal saying why", async () => {
		const said: string[] = [];
		const { file, summary } = snapshotHeap(ONE, "idle", undefined, {
			folder,
			say: (line) => said.push(line),
			write: (into) => writeFileSync(into, "raw"),
			sum: () =>
				Promise.reject(new Error("the summing process ended with status 1")),
		});

		await vi.waitFor(() => expect(said).toHaveLength(2));
		expect(said[1]).toMatch(
			new RegExp(
				`^Heap snapshot ${file} could not be summed after \\d+ ms, so the raw file stays for its asker, or the sweep once 120 minutes old: the summing process ended with status 1$`,
			),
		);
		expect(await readFile(file, "utf8"), "the raw file stays").toBe("raw");
		await expect(stat(summary), "no summary written").rejects.toThrow("ENOENT");
	});

	it("keeps the raw file when its sum throws as it starts, still answering", async () => {
		const said: string[] = [];
		const { file } = snapshotHeap(ONE, "idle", undefined, {
			folder,
			say: (line) => said.push(line),
			write: () => undefined,
			sum: () => {
				throw new Error("spawn ENOENT");
			},
		});

		await vi.waitFor(() => expect(said).toHaveLength(2));
		expect(said[1]).toContain("could not be summed");
		expect(said[1]).toContain("spawn ENOENT");
		await expect(stat(file)).resolves.toBeDefined();
	});

	it("is refused while its conversation is busy, writing nothing", async () => {
		let wrote = false;
		expect(() =>
			snapshotHeap(ONE, "busy", undefined, {
				...summed,
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
		await mkdir(raws, { recursive: true });
		const file = join(raws, `${ONE}-${STAMP}.heapsnapshot`);
		await writeFile(file, "kept");

		expect(() =>
			snapshotHeap(ONE, "idle", undefined, {
				...summed,
				folder,
				now: () => AT,
				write: () => undefined,
			}),
		).toThrow("EEXIST");
	});

	it("first removes the raw files and summaries left past their time, and nothing else there", async () => {
		await mkdir(raws, { recursive: true });
		const staleRaw = join(raws, "stale.heapsnapshot");
		const staleSummary = join(folder, "stale.summary.json");
		// Where a host from before the hidden folder wrote its raw files.
		const staleBeside = join(folder, "beside.heapsnapshot");
		const kept = [
			join(raws, "young.heapsnapshot"),
			join(folder, "young.summary.json"),
			join(folder, "notes.txt"),
			join(raws, "notes.txt"),
		];
		const past = new Date(AT.getTime() - SNAPSHOT_KEPT_MS - MS_PER_MINUTE);
		const inTime = new Date(AT.getTime() - SNAPSHOT_KEPT_MS + MS_PER_MINUTE);
		for (const file of [staleRaw, staleSummary, staleBeside, ...kept]) {
			await writeFile(file, "x");
			const when = file.includes("young") ? inTime : past;
			await utimes(file, when, when);
		}
		const said: string[] = [];

		const { file, summary } = snapshotHeap(ONE, "idle", undefined, {
			...summed,
			folder,
			now: () => AT,
			say: (line) => said.push(line),
			write: () => undefined,
		});

		expect((await readdir(raws)).sort()).toEqual(
			["notes.txt", "young.heapsnapshot", file.slice(raws.length + 1)].sort(),
		);
		await vi.waitFor(() => expect(said).toHaveLength(5));
		expect((await readdir(folder)).sort()).toEqual(
			[
				RAW_FOLDER,
				"notes.txt",
				"young.summary.json",
				summary.slice(folder.length + 1),
			].sort(),
		);
		const minutes = SNAPSHOT_KEPT_MS / MS_PER_MINUTE + 1;
		expect(said.slice(0, 3)).toEqual([
			`Removed heap snapshot ${staleRaw}, written ${minutes} minutes ago`,
			`Removed heap snapshot ${staleBeside}, written ${minutes} minutes ago`,
			`Removed heap snapshot summary ${staleSummary}, written ${minutes} minutes ago`,
		]);
	});

	it("removes the partial file of a write that fails, saying so, and still fails", async () => {
		const said: string[] = [];
		expect(() =>
			snapshotHeap(ONE, "idle", "scripts/host-memory.ts", {
				...summed,
				folder,
				clock: clockTaking(700),
				say: (line) => said.push(line),
				write: (file) => {
					writeFileSync(file, "half");
					throw new Error("ENOSPC: no space left on device");
				},
			}),
		).toThrow("ENOSPC");

		expect(await readdir(raws), "no partial snapshot kept").toEqual([]);
		expect(said).toEqual([
			`A heap snapshot of conversation ${ONE}'s process, asked by scripts/host-memory.ts over the control socket, failed after 700 ms, and its partial file was removed: ENOSPC: no space left on device`,
		]);
	});

	it(
		"is V8's own snapshot unless told how to write one, into the file made for it",
		async () => {
			const { file, bytes } = snapshotHeap(ONE, "idle", undefined, {
				...summed,
				folder,
			});

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
		},
		REAL_WRITE_MS,
	);
});
