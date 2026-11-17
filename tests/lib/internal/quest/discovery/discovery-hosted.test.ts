/**
 * Discovery on a host, where every conversation shares one thread.
 *
 * Signing the tree is a listing a folder and a stat a file, 6,072 calls
 * over 1,437 quests on 17 November, and on a host each one holds every
 * conversation while the disk answers. So a host answers a known tree
 * from its last signed walk and signs it again off the thread, while
 * this process's own writes, a quest made or removed, and an ask that
 * must be fresh still sign at once. Plain pi signs every ask, as before.
 */

import * as fs from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
	discoverQuestsAfresh,
	discoverQuestsFresh,
	discoverySettled,
	signQuestsNow,
} from "../../../../../lib/internal/quest/discovery/discovery.ts";
import { atomicWriteFile } from "../../../../../lib/internal/quest/io.ts";
import { installTestHost } from "../../../../support/session-host.ts";
import {
	ID,
	readme,
	settledTree,
	writeSettled,
} from "../support/discovery-tree.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		readdirSync: vi.fn(actual.readdirSync),
		statSync: vi.fn(actual.statSync),
	};
});

const reads = vi.mocked(fs.readFileSync);
const listings = vi.mocked(fs.readdirSync);
const stats = vi.mocked(fs.statSync);

const OTHER = "QEST-20260604-CCC333";

let root: string;
let readmePath: string;
let host: ReturnType<typeof installTestHost> | undefined;

function statusNow(): string | undefined {
	return discoverQuests(root).index.quests.get(ID)?.doc.frontMatter.status;
}

function questIds(): string[] {
	return [...discoverQuests(root).index.quests.keys()];
}

function syncCalls(): number {
	return (
		reads.mock.calls.length +
		listings.mock.calls.length +
		stats.mock.calls.length
	);
}

function clearCalls(): void {
	reads.mockClear();
	listings.mockClear();
	stats.mockClear();
}

/** Move the clock past when a host signs a known tree again. */
function later(ms: number): void {
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + ms);
}

/** A quest README another process wrote, settled. */
function otherQuest(): void {
	mkdirSync(join(root, OTHER));
	writeSettled(
		join(root, OTHER, "README.md"),
		readme("active").replaceAll(ID, OTHER),
	);
}

beforeEach(() => {
	({ root, readmePath } = settledTree());
	clearDiscoveryCache();
	clearCalls();
});

afterEach(() => {
	vi.restoreAllMocks();
	host?.dispose();
	host = undefined;
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("discovery on a host", () => {
	beforeEach(() => {
		host = installTestHost();
	});

	it("answers a known tree without listing a folder or reading a file", () => {
		const first = discoverQuests(root);
		clearCalls();
		expect(discoverQuests(root)).toBe(first);
		expect(listings.mock.calls).toEqual([]);
		expect(reads.mock.calls).toEqual([]);
	});

	it("shows another process's change by the next signing off the thread, not before", async () => {
		expect(statusNow()).toBe("active");
		writeSettled(readmePath, readme("paused"));
		expect(statusNow()).toBe("active");
		later(61_000);
		expect(statusNow()).toBe("active");
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("signs off the thread with no call that holds it", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		later(61_000);
		discoverQuests(root);
		clearCalls();
		await discoverySettled(root);
		expect(syncCalls()).toBe(0);
		expect(statusNow()).toBe("paused");
	});

	it("signs again a few seconds on, well inside a minute", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		later(6_000);
		discoverQuests(root);
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("starts one signing at a time for a root", async () => {
		discoverQuests(root);
		later(61_000);
		discoverQuests(root);
		const under = discoverySettled(root);
		discoverQuests(root);
		expect(discoverySettled(root)).toBe(under);
		await under;
	});

	it("shows this process's own write at once", () => {
		expect(statusNow()).toBe("active");
		atomicWriteFile(readmePath, readme("paused"));
		expect(statusNow()).toBe("paused");
	});

	it("finds a quest made elsewhere at once, by its id", () => {
		discoverQuests(root);
		otherQuest();
		expect(questIds()).toContain(OTHER);
	});

	it("finds a quest whose README came after its folder at once", () => {
		mkdirSync(join(root, OTHER));
		expect(questIds()).not.toContain(OTHER);
		writeSettled(
			join(root, OTHER, "README.md"),
			readme("active").replaceAll(ID, OTHER),
		);
		expect(questIds()).toContain(OTHER);
	});

	it("drops a quest removed elsewhere at once", () => {
		otherQuest();
		discoverQuests(root);
		rmSync(join(root, OTHER), { recursive: true });
		expect(questIds()).not.toContain(OTHER);
	});

	it("keeps no signing made across this process's own write", async () => {
		discoverQuests(root);
		later(61_000);
		discoverQuests(root);
		atomicWriteFile(readmePath, readme("paused"));
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("signs at once when asked for the tree as it stands", () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		const fresh = discoverQuestsFresh(root);
		expect(fresh.index.quests.get(ID)?.doc.frontMatter.status).toBe("paused");
	});

	it("answers the asks after a signing now as the tree stood then", () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		signQuestsNow(root);
		expect(statusNow()).toBe("paused");
	});

	it("signs afresh off the thread when asked to wait for it", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		clearCalls();
		const fresh = await discoverQuestsAfresh(root);
		expect(fresh.index.quests.get(ID)?.doc.frontMatter.status).toBe("paused");
		expect(listings.mock.calls).toEqual([]);
	});
});

describe("discovery on plain pi", () => {
	it("signs every ask, as it always has", () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		clearCalls();
		expect(statusNow()).toBe("paused");
		expect(listings.mock.calls.length).toBeGreaterThan(0);
	});

	it("waits for nothing when asked to sign afresh", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		const fresh = await discoverQuestsAfresh(root);
		expect(fresh.index.quests.get(ID)?.doc.frontMatter.status).toBe("paused");
	});
});
