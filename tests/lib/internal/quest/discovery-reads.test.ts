/**
 * How often discovery reads the quest tree.
 *
 * pi runs discovery at every session start, over a tree that holds tens
 * of megabytes of markdown, and quest verbs run it again on most calls.
 * These count reads at the filesystem boundary: a cold walk reads each
 * file once, and a warm one only re-reads what has changed. The seed a
 * walk leaves for the next process is in discovery-seed.test.ts.
 */

import * as fs from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import {
	ID,
	plan,
	readme,
	settledTree,
	writeSettled,
} from "./support/discovery-tree.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		readdirSync: vi.fn(actual.readdirSync),
	};
});

const reads = vi.mocked(fs.readFileSync);
const listings = vi.mocked(fs.readdirSync);

let root: string;

function readsOf(path: string): number {
	return reads.mock.calls.filter(([p]) => p === path).length;
}

function listingsOf(path: string): number {
	return listings.mock.calls.filter(([p]) => p === path).length;
}

let readmePath: string;
let planPath: string;

beforeEach(() => {
	({ root, readmePath, planPath } = settledTree());
	clearDiscoveryCache();
	reads.mockClear();
	listings.mockClear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("discovery reads", () => {
	it("reads each file once on a cold walk", () => {
		const result = discoverQuests(root);
		expect(result.index.quests.get(ID)?.documents).toHaveLength(1);
		expect(readsOf(readmePath)).toBe(1);
		expect(readsOf(planPath)).toBe(1);
	});

	it("reads nothing again while settled files are unchanged", () => {
		const first = discoverQuests(root);
		reads.mockClear();
		expect(discoverQuests(root)).toBe(first);
		expect(readsOf(readmePath)).toBe(0);
		expect(readsOf(planPath)).toBe(0);
	});

	it("re-reads a settled file once it changes", () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		const second = discoverQuests(root);
		expect(second.index.quests.get(ID)?.doc.frontMatter.status).toBe("paused");
	});

	it("lists each directory once on a cold walk, and only those that exist", () => {
		discoverQuests(root);
		const questDir = join(root, ID);
		expect(listingsOf(root)).toBe(1);
		expect(listingsOf(questDir)).toBe(1);
		expect(listingsOf(join(questDir, "plans"))).toBe(1);
		expect(listingsOf(join(questDir, "research"))).toBe(0);
	});

	it("keeps re-reading a file written too recently to trust its stat", () => {
		writeFileSync(readmePath, readme("active"));
		discoverQuests(root);
		reads.mockClear();
		discoverQuests(root);
		expect(readsOf(readmePath)).toBe(1);
	});
});

describe("a rebuild after a change", () => {
	// Any change misses the index; only what changed is parsed again.

	it("reads only the file that changed", () => {
		discoverQuests(root);
		writeSettled(planPath, plan("A New Plan"));
		reads.mockClear();
		const result = discoverQuests(root);
		const [document] = result.index.quests.get(ID)?.documents ?? [];
		expect(document?.doc.title).toBe("A New Plan");
		expect(readsOf(planPath)).toBe(1);
		expect(readsOf(readmePath)).toBe(0);
	});

	it("drops a removed document and adds a new one", () => {
		discoverQuests(root);
		rmSync(planPath);
		const newPath = join(root, ID, "plans", "PLAN-20260604-CCC333.md");
		writeSettled(newPath, plan("Another", "PLAN-20260604-CCC333"));
		const documents = discoverQuests(root).index.quests.get(ID)?.documents;
		expect(documents?.map((d) => d.path)).toEqual([newPath]);
	});

	it("reports a README that no longer parses, every walk, until it does", () => {
		discoverQuests(root);
		writeSettled(readmePath, "no front matter\n");
		const broken = discoverQuests(root);
		expect([...broken.index.quests.keys()]).not.toContain(ID);
		expect(broken.errors.map((e) => e.message)).toContain(
			"Front-matter invalid or absent.",
		);
		writeSettled(planPath, plan("Touched"));
		expect(discoverQuests(root).errors).toHaveLength(1);
		writeSettled(readmePath, readme("paused"));
		const mended = discoverQuests(root);
		expect(mended.index.quests.get(ID)?.doc.frontMatter.status).toBe("paused");
		expect(mended.errors).toEqual([]);
	});

	it("parses afresh once the memo is cleared", () => {
		discoverQuests(root);
		clearDiscoveryCache();
		reads.mockClear();
		discoverQuests(root);
		expect(readsOf(readmePath)).toBe(1);
		expect(readsOf(planPath)).toBe(1);
	});
});

describe("a record's body", () => {
	// The index keeps front matter and titles; prose stays on disk.
	it("is read from its file only when asked for", () => {
		const result = discoverQuests(root);
		reads.mockClear();
		const entry = result.index.quests.get(ID);
		expect(readsOf(readmePath)).toBe(0);

		expect(entry?.doc.body).toContain("# Alpha");
		expect(entry?.documents[0]?.doc.body).toContain("# A Plan");
		expect(readsOf(readmePath)).toBe(1);
		expect(readsOf(planPath)).toBe(1);
	});

	it("is not kept in the index, so it reads as the file now says", () => {
		const entry = discoverQuests(root).index.quests.get(ID);
		writeSettled(planPath, `${plan()}\nA line added since the walk.\n`);
		expect(entry?.documents[0]?.doc.body).toContain("added since the walk");
		expect(entry?.documents[0]?.doc.title).toBe("A Plan");
	});

	it("is empty once its file is gone", () => {
		const entry = discoverQuests(root).index.quests.get(ID);
		rmSync(planPath);
		expect(entry?.documents[0]?.doc.body).toBe("");
	});
});

describe("one index for the whole process", () => {
	// pi loads each extension through its own module graph and never
	// unloads one, so several copies of discovery run in one process.
	async function anotherCopy(): Promise<typeof discoverQuests> {
		vi.resetModules();
		const copy = await import(
			"../../../../lib/internal/quest/discovery/discovery.ts"
		);
		expect(copy.discoverQuests).not.toBe(discoverQuests);
		return copy.discoverQuests;
	}

	it("is shared by every copy of the module, so a second copy reads nothing", async () => {
		const first = discoverQuests(root);
		const discoverAgain = await anotherCopy();
		reads.mockClear();

		expect(discoverAgain(root)).toBe(first);
		expect(readsOf(readmePath)).toBe(0);
	});

	it("is let go entirely when cleared, so no copy keeps it", () => {
		discoverQuests(root);
		clearDiscoveryCache();
		expect(
			(globalThis as Record<symbol, unknown>)[
				Symbol.for("agentic-harness.quest-discovery")
			],
		).toBeUndefined();
	});
});
