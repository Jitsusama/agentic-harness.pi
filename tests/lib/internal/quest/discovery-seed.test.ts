/**
 * The seed discovery leaves for the next process.
 *
 * A process's memo starts empty, and so does one a reload clears: on
 * 30 October that first walk took 17.2 s at CPU pressure 76%, over
 * 772 quests, paid by every start and by 40 sessions at once after
 * each install. These count reads at the filesystem boundary, as
 * discovery-reads.test.ts does, across a memo cleared between walks.
 */

import * as fs from "node:fs";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import {
	ID,
	plan,
	settledTree,
	writeSettled,
} from "./support/discovery-tree.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
	};
});

const reads = vi.mocked(fs.readFileSync);

let root: string;
let readmePath: string;
let planPath: string;
let seeds: string;

function readsOf(path: string): number {
	return reads.mock.calls.filter(([p]) => p === path).length;
}

beforeEach(() => {
	({ root, readmePath, planPath } = settledTree());
	seeds = mkdtempSync(join(tmpdir(), "disc-seeds-"));
	clearDiscoveryCache();
	reads.mockClear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(seeds, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("a seed left for the next process", () => {
	const seeded = () => {
		discoverQuests(root, { dir: seeds, after: 1 });
		clearDiscoveryCache();
		reads.mockClear();
	};

	it("lets a fresh memo read nothing the seed vouches for", () => {
		seeded();

		const entry = discoverQuests(root, { dir: seeds }).index.quests.get(ID);

		expect(readsOf(readmePath)).toBe(0);
		expect(readsOf(planPath)).toBe(0);
		expect(entry?.doc.frontMatter.status).toBe("active");
		expect(entry?.documents[0]?.doc.title).toBe("A Plan");
		expect(entry?.doc.body).toContain("# Alpha");
	});

	it("still reads and parses a file changed since the seed was left", () => {
		seeded();
		writeSettled(planPath, plan("A New Plan"));

		const entry = discoverQuests(root, { dir: seeds }).index.quests.get(ID);

		expect(entry?.documents[0]?.doc.title).toBe("A New Plan");
		expect(readsOf(planPath)).toBe(1);
		expect(readsOf(readmePath)).toBe(0);
	});

	it("is not left by a walk that parsed only a few files", () => {
		discoverQuests(root, { dir: seeds });

		expect(fs.readdirSync(seeds)).toEqual([]);
	});

	it("is passed over when it can't be read, and the walk reads everything", () => {
		discoverQuests(root, { dir: seeds, after: 1 });
		for (const name of fs.readdirSync(seeds)) {
			writeFileSync(join(seeds, name), "not a seed");
		}
		clearDiscoveryCache();
		reads.mockClear();

		const entry = discoverQuests(root, { dir: seeds }).index.quests.get(ID);

		expect(entry?.doc.frontMatter.status).toBe("active");
		expect(readsOf(readmePath)).toBe(1);
	});

	// Three versions of this code ran at once on 3 November, each
	// rejecting the others' seed and writing its own over it: 19 times
	// in 45 minutes, each after a walk that parsed everything.
	it("is kept for each version of the code, so one never displaces another's", () => {
		discoverQuests(root, { dir: seeds, after: 1, code: "older" });
		clearDiscoveryCache();
		discoverQuests(root, { dir: seeds, after: 1, code: "newer" });
		clearDiscoveryCache();
		reads.mockClear();

		discoverQuests(root, { dir: seeds, code: "older" });

		expect(readsOf(readmePath)).toBe(0);
		expect(readsOf(planPath)).toBe(0);
	});

	it("lets go of another version's seed once nothing has left it for a day", () => {
		discoverQuests(root, { dir: seeds, after: 1, code: "older" });
		const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		for (const name of fs.readdirSync(seeds)) {
			utimesSync(join(seeds, name), lastWeek, lastWeek);
		}
		clearDiscoveryCache();
		discoverQuests(root, { dir: seeds, after: 1, code: "newer" });
		clearDiscoveryCache();
		reads.mockClear();

		discoverQuests(root, { dir: seeds, code: "older" });

		expect(readsOf(readmePath)).toBe(1);
	});

	// The seed's key hashes the modules beside the one that computes it, so
	// a move of that module out of the folder would key seeds by the wrong
	// code and leave records shaped by an older parse standing.
	it("is keyed by every module that shapes a record, the walk's included", async () => {
		vi.resetModules();
		const freshFs = await import("node:fs");
		const { codeKey } = await import(
			"../../../../lib/internal/quest/discovery-seed.ts"
		);
		const freshReads = vi.mocked(freshFs.readFileSync);
		freshReads.mockClear();

		codeKey();

		const hashed = freshReads.mock.calls.map(([path]) => String(path));
		const quest = join(import.meta.dirname, "../../../../lib/internal/quest");
		for (const name of [
			"discovery.ts",
			"discovery-reads.ts",
			"discovery-seed.ts",
			"frontmatter.ts",
			"quest-doc.ts",
		]) {
			expect(hashed, `${name} is hashed`).toContain(join(quest, name));
		}
	});
});
