/**
 * How often discovery reads the quest tree.
 *
 * pi runs discovery at every session start, over a tree that holds tens
 * of megabytes of markdown, and quest verbs run it again on most calls.
 * These count reads at the filesystem boundary: a cold walk reads each
 * file once, and a warm one only re-reads what has changed.
 */

import * as fs from "node:fs";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery.ts";

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

const ID = "QEST-20260604-AAA111";

function readme(status: string): string {
	return [
		"---",
		`id: ${ID}`,
		"kind: quest",
		"parent: null",
		`status: ${status}`,
		"priority: active",
		"rank: 1",
		"started: 2026-06-04",
		"updated: 2026-06-04",
		"aliases: []",
		"sessions: []",
		"---",
		"",
		"# Alpha",
		"",
	].join("\n");
}

function plan(): string {
	return [
		"---",
		"id: PLAN-20260604-BBB222",
		"kind: plan",
		`quest: ${ID}`,
		"stage: think",
		"updated: 2026-06-04",
		"---",
		"",
		"# A Plan",
		"",
	].join("\n");
}

/** Write a file and date it well before now, as a settled file would be. */
function writeSettled(path: string, text: string): void {
	writeFileSync(path, text);
	const past = new Date(Date.now() - 60_000);
	utimesSync(path, past, past);
}

function readsOf(path: string): number {
	return reads.mock.calls.filter(([p]) => p === path).length;
}

function listingsOf(path: string): number {
	return listings.mock.calls.filter(([p]) => p === path).length;
}

let readmePath: string;
let planPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "disc-reads-"));
	const dir = join(root, ID);
	mkdirSync(join(dir, "plans"), { recursive: true });
	readmePath = join(dir, "README.md");
	planPath = join(dir, "plans", "PLAN-20260604-BBB222.md");
	writeSettled(readmePath, readme("active"));
	writeSettled(planPath, plan());
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
