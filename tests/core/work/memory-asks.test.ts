/**
 * When a tree was last asked for, as its record dates it: the mark a
 * sweep's take of an open session's snapshot is judged against, since
 * reading a snapshot leaves none on a disk without access times.
 */

import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Owner } from "../../../lib/core/process/index.ts";
import {
	createTreeBroker,
	type HeldTree,
} from "../../../lib/core/work/broker.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-memory-asks-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const memoryAt = () => createTreeMemory(join(root, "cut"));

/** A tree on disk, held by these owners or by nobody recorded. */
function tree(key: string, ...owners: Owner[]): HeldTree {
	// A real directory, since recall drops a record whose tree has gone.
	const path = join(root, key);
	mkdirSync(path, { recursive: true });
	return {
		identity: { key, shareable: true },
		path,
		providerId: "git",
		...(owners.length === 0 ? {} : { owners }),
	};
}

it("dates each ask for a tree, so one asked for since the sweep looked stays", async () => {
	// The ask is the mark, and the sweep's take is judged against it
	// under the record's lock.
	const memory = memoryAt();
	const facts = { alive: () => true, startedAt: async () => 5000 };
	const looked = Date.now() - 1;
	memory.remember(tree("shared"));

	await memory.rememberHeldByUs(tree("shared"), facts);
	const usedAt = memory.recall()[0]?.usedAt ?? 0;
	let moved = false;
	const taken = await memory.whileUnusedSince(
		tree("shared").path,
		looked,
		async () => {
			moved = true;
			return true;
		},
	);

	expect(usedAt, "the ask wasn't dated").toBeGreaterThan(looked);
	expect(taken, "a tree asked for since was taken").toBeUndefined();
	expect(moved, "a tree asked for since was moved").toBe(false);
	// The record's own write dates the ask too, a moment after usedAt.
	const written = statSync(
		join(root, "cut", `${tree("shared").identity.key}.json`),
	).mtimeMs;
	expect(
		await memory.whileUnusedSince(
			tree("shared").path,
			Math.max(usedAt, written),
			async () => true,
		),
		"a tree unused since was kept",
	).toBeDefined();
	expect(memory.recall(), "the taken tree's record stayed").toEqual([]);
});

it("dates an ask by its record's own write, as code from before the dating leaves it", async () => {
	// Code from before the dating writes back the record it read, a
	// stale date or none among it, but every version rewrites the file.
	const memory = memoryAt();
	const ours = { pid: 4001, startedAt: 1000 };
	const written = (key: string, ago: number) => {
		const at = (Date.now() - ago) / 1000;
		utimesSync(join(root, "cut", `${key}.json`), at, at);
	};
	const HOURS = 5 * 60 * 60 * 1000;
	memory.remember({ ...tree("stale", ours), usedAt: 1000 });
	memory.remember({ ...tree("undated", ours) });
	memory.remember({ ...tree("aged", ours), usedAt: 1000 });
	written("aged", HOURS);
	memory.remember({ ...tree("undatedAged", ours) });
	written("undatedAged", HOURS);
	const since = Date.now() - HOURS / 2;
	const moved: string[] = [];

	for (const key of ["stale", "undated", "aged", "undatedAged"]) {
		await memory.whileUnusedSince(tree(key).path, since, async () => {
			moved.push(key);
			return true;
		});
	}

	expect(
		moved,
		"a tree was taken whose record was written since, or one written long ago was kept",
	).toEqual(["aged", "undatedAged"]);
	expect(
		memory.askedAt(tree("undatedAged").path),
		"a taken tree's record still answered when it was written",
	).toBeUndefined();
});

it("dates an ask given its key by that record alone, not by the listing", () => {
	// A sweep dates every held snapshot, and listing every record for
	// each read the folder hundreds of thousands of times.
	const memory = memoryAt();
	const ours = { pid: 4001, startedAt: 1000 };
	memory.remember({ ...tree("filed", ours) });
	// Whole seconds, which a file's time holds exactly.
	const at = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
	utimesSync(join(root, "cut", "filed.json"), at, at);

	expect(
		memory.askedAt(tree("filed").path, "filed"),
		"its own record's write didn't date the ask",
	).toBe(at * 1000);
	expect(
		memory.askedAt(tree("filed").path, "renamed"),
		"a record under another name dated the ask, so every record was listed",
	).toBeUndefined();
});

it("keeps a tree whose record, filed under another name, can't date its ask", async () => {
	// Undated is not unused: a record its own file can't be found for
	// says nothing of when it was last asked for.
	const memory = memoryAt();
	const ours = { pid: 4001, startedAt: 1000 };
	memory.remember({ ...tree("misfiled", ours), usedAt: 1000 });
	renameSync(
		join(root, "cut", "misfiled.json"),
		join(root, "cut", "other.json"),
	);
	expect(
		memory.recall().map((one) => one.identity.key),
		"the misfiled record isn't recalled, so this case tests nothing",
	).toEqual(["misfiled"]);
	let moved = false;

	const taken = await memory.whileUnusedSince(
		tree("misfiled").path,
		Date.now(),
		async () => {
			moved = true;
			return true;
		},
	);

	expect(taken, "an undated tree was taken").toBeUndefined();
	expect(moved, "an undated tree was moved").toBe(false);
});

it("answers a use as gone, and leaves no record, once a sweep took the tree", async () => {
	// The broker dates a reader's use by writing the record, which must
	// not bring back the record of a tree the sweep just took.
	const memory = memoryAt();
	const held = tree("snap");
	memory.remember(held);
	const broker = createTreeBroker({ providers: [], memory });
	await memory.whileUnusedSince(held.path, Date.now() + 1000, async () => {
		rmSync(held.path, { recursive: true });
		return true;
	});

	const stands = await broker.used(held);

	expect(stands, "a taken tree's use reads as standing").toBe(false);
	expect(memory.recall(), "dating the use brought its record back").toEqual([]);
	expect(
		broker.cutHere(held.path),
		"a taken tree is still listed as this session's",
	).toBe(false);
});
