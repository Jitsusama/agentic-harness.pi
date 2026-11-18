/**
 * Signing the quest tree on a thread of its own. On the host's thread
 * each of the signing's thousands of calls waited for the pool every
 * conversation's reads share and for a turn of the host's loop, and
 * under load a signing took close to a minute. On its own thread it
 * makes no call of the host's, reads what the walk on the host would
 * have read, and reads the bytes only of files that changed.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
	mkdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as promises from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../../lib/internal/quest/discovery/discovery.ts";
import {
	discoverySignature,
	newPass,
} from "../../../../../lib/internal/quest/discovery/discovery-reads.ts";
import {
	folderStampOf,
	pendingStampOf,
	readTreeOffThread,
	threadsLetGo,
} from "../../../../../lib/internal/quest/discovery/off-thread.ts";
import {
	ID,
	readme,
	settle,
	settledTree,
	writeSettled,
} from "../support/discovery-tree.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		readdirSync: vi.fn(actual.readdirSync),
		realpathSync: vi.fn(actual.realpathSync),
		statSync: vi.fn(actual.statSync),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: vi.fn(actual.readFile),
		readdir: vi.fn(actual.readdir),
		realpath: vi.fn(actual.realpath),
		stat: vi.fn(actual.stat),
	};
});

const hostCalls = [
	vi.mocked(fs.readFileSync),
	vi.mocked(fs.readdirSync),
	vi.mocked(fs.realpathSync),
	vi.mocked(fs.statSync),
	vi.mocked(promises.readFile),
	vi.mocked(promises.readdir),
	vi.mocked(promises.realpath),
	vi.mocked(promises.stat),
];

const NESTED = "QEST-20260604-CCC333";

/** Far longer than a signing of this small tree takes. */
const WALL_MS = 60_000;

let root: string;
let readmePath: string;
let planPath: string;

beforeEach(() => {
	({ root, readmePath, planPath } = settledTree());
	// What the walk reads beyond one quest and its plan: a nested quest,
	// a stray file, a hidden folder and a linked kind folder.
	mkdirSync(join(root, ID, NESTED));
	writeSettled(join(root, "stray.txt"), "not a quest");
	mkdirSync(join(root, ".hidden"));
	mkdirSync(join(root, "elsewhere"));
	symlinkSync(join(root, "elsewhere"), join(root, ID, "research"));
	writeSettled(join(root, "elsewhere", "notes.txt"), "kept beside");
	settle(join(root, ID));
	settle(root);
	clearDiscoveryCache();
	for (const call of hostCalls) call.mockClear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

it("signs with no filesystem call on the host's own thread", async () => {
	const { pass, rootStamp } = await readTreeOffThread(root, WALL_MS);

	expect(
		hostCalls.flatMap((call) =>
			call.mock.calls.map((args: readonly unknown[]) => String(args[0])),
		),
		"every read was the signing thread's",
	).toEqual([]);
	expect(rootStamp, "the root's stamp came back").toBeDefined();
	expect(
		[...pass.hashes.keys()].sort(),
		"the README and every document file were hashed",
	).toEqual(
		[readmePath, planPath, join(root, ID, "research", "notes.txt")].sort(),
	);
	expect(
		pass.listings.has(join(root, ID, NESTED)),
		"the nested quest was listed, for its layout error",
	).toBe(true);
});

it("reads what the walk on the host would have read", async () => {
	const { pass } = await readTreeOffThread(root, WALL_MS);
	for (const call of hostCalls) call.mockClear();
	const offThread = discoverySignature(root, pass);

	expect(
		hostCalls.flatMap((call) =>
			call.mock.calls.map((args: readonly unknown[]) => String(args[0])),
		),
		"the thread's pass left the signature nothing to read itself",
	).toEqual([]);
	clearDiscoveryCache();
	expect(offThread).toBe(discoverySignature(root, newPass()));
});

it("stamps the root and each quest folder as the host would", async () => {
	const bare = join(root, "QEST-20260605-DDD444");
	mkdirSync(bare);
	settle(bare);
	settle(root);

	const { pass, rootStamp } = await readTreeOffThread(root, WALL_MS);

	expect(rootStamp, "the root's stamp").toBe(folderStampOf(root));
	expect(rootStamp, "the root has a stamp to compare").toBeDefined();
	for (const dir of [join(root, ID), bare])
		expect(pass.pending.get(dir), `the pending stamp of ${dir}`).toBe(
			pendingStampOf(dir),
		);
});

it("re-reads a file the walk parses until its record is kept", async () => {
	await readTreeOffThread(root, WALL_MS);

	const again = await readTreeOffThread(root, WALL_MS);

	expect(
		[...again.pass.bytes.keys()].sort(),
		"the README and plan, which have no record yet, but not the notes",
	).toEqual([readmePath, planPath].sort());
});

it("re-reads a file each signing while it is still being written", async () => {
	writeFileSync(readmePath, readme("concluded"));
	// Written a minute ahead, so it stays unsettled however slowly the
	// two threads start.
	const ahead = new Date(Date.now() + 60_000);
	utimesSync(readmePath, ahead, ahead);
	discoverQuests(root);

	const first = await readTreeOffThread(root, WALL_MS);
	const second = await readTreeOffThread(root, WALL_MS);

	expect([...first.pass.bytes.keys()], "read while unsettled").toEqual([
		readmePath,
	]);
	expect([...second.pass.bytes.keys()], "and read again").toEqual([readmePath]);
});

it("ends a thread that hasn't answered in time", async () => {
	await expect(readTreeOffThread(root, 1)).rejects.toThrow(
		"the signing thread hadn't answered after 1 ms",
	);

	const stopping = threadsLetGo();
	expect(stopping, "the thread is let go until it stops").toHaveLength(1);
	await Promise.all(stopping);
	expect(threadsLetGo(), "and is forgotten once stopped").toHaveLength(0);
});

it("starts no thread while one ended past its wall hasn't stopped", async () => {
	await expect(readTreeOffThread(root, 1)).rejects.toThrow("after 1 ms");

	await expect(
		readTreeOffThread(root, WALL_MS),
		"a hung disk holds one thread, never one more each signing",
	).rejects.toThrow("hasn't stopped, so its disk still hangs");

	await Promise.all(threadsLetGo());
	await expect(
		readTreeOffThread(root, WALL_MS),
		"and signs again once it stops",
	).resolves.toBeDefined();
});

// A FIFO found by the stat; one swapped in between the stat and the
// open, which the open's O_NONBLOCK guards, no test here can time.
it("reads a FIFO in a file's place as absent, without waiting on it", async () => {
	rmSync(readmePath);
	expect(spawnSync("mkfifo", [readmePath]).status, "a FIFO made").toBe(0);

	const read = await readTreeOffThread(root, WALL_MS);

	expect(read.pass.bytes.has(readmePath), "no bytes from a FIFO").toBe(false);
	expect(read.pass.absent.has(readmePath), "taken as absent").toBe(true);
});

it("reads the bytes only of files that changed since the last walk", async () => {
	const first = await readTreeOffThread(root, WALL_MS);
	expect(first.pass.bytes.size, "a cold signing reads every file").toBe(3);
	// The walk keeps each README's and document's record, which a stamp
	// needs to stand for a file the walk parses.
	discoverQuests(root);

	const warm = await readTreeOffThread(root, WALL_MS);
	expect(
		[...warm.pass.bytes.keys()],
		"an unchanged tree's stamps stand for every file",
	).toEqual([]);

	// A status of another length, so the size differs even where file
	// times are coarse.
	writeSettled(readmePath, readme("concluded"));
	const changed = await readTreeOffThread(root, WALL_MS);
	expect([...changed.pass.bytes.keys()]).toEqual([readmePath]);
});
