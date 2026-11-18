/**
 * Signing the quest tree on a thread of its own. On the host's thread
 * each of the signing's thousands of calls waited for the pool every
 * conversation's reads share and for a turn of the host's loop, and
 * under load a signing took close to a minute. On its own thread it
 * makes no call of the host's, reads what the walk on the host would
 * have read, and reads the bytes only of files that changed.
 */

import * as fs from "node:fs";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
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
import { readTreeOffThread } from "../../../../../lib/internal/quest/discovery/off-thread.ts";
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
	const { pass, rootStamp } = await readTreeOffThread(root);

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
	const { pass } = await readTreeOffThread(root);
	const offThread = discoverySignature(root, pass);
	clearDiscoveryCache();

	expect(offThread).toBe(discoverySignature(root, newPass()));
});

it("reads the bytes only of files that changed since the last walk", async () => {
	const first = await readTreeOffThread(root);
	expect(first.pass.bytes.size, "a cold signing reads every file").toBe(3);
	// The walk keeps each README's and document's record, which a stamp
	// needs to stand for a file the walk parses.
	discoverQuests(root);

	const warm = await readTreeOffThread(root);
	expect(
		[...warm.pass.bytes.keys()],
		"an unchanged tree's stamps stand for every file",
	).toEqual([]);

	writeSettled(readmePath, readme("paused"));
	const changed = await readTreeOffThread(root);
	expect([...changed.pass.bytes.keys()]).toEqual([readmePath]);
});
