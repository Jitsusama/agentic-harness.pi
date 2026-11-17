/**
 * Discovery on a host, where every conversation shares one thread.
 *
 * Signing the tree is a listing a folder and a stat a file, 6,072 calls
 * over 1,437 quests on 17 November, and on a host each one holds every
 * conversation while the disk answers. So a host answers a known tree
 * from its last signed walk and signs it again off the thread, while
 * this process's own writes, a quest made, removed or given its README,
 * and an ask after a minute unasked still sign at once. Plain pi signs
 * every ask, as before.
 */

import * as fs from "node:fs";
import { mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
	discoverQuestsAfresh,
	discoverySettled,
	signQuestsNow,
} from "../../../../../lib/internal/quest/discovery/discovery.ts";
import { atomicWriteFile } from "../../../../../lib/internal/quest/io.ts";
import { installTestHost } from "../../../../support/session-host.ts";
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

/**
 * A seam in the signing off the thread: `onRead` hears when its reads
 * are done, and `gate` holds what they found back until it opens, as a
 * slow or hung disk would.
 */
const signing = vi.hoisted(() => ({
	onRead: undefined as (() => void) | undefined,
	gate: undefined as Promise<void> | undefined,
}));

vi.mock(
	"../../../../../lib/internal/quest/discovery/off-thread.ts",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../../../lib/internal/quest/discovery/off-thread.ts")
			>();
		return {
			...actual,
			readTreeOffThread: async (questsRoot: string) => {
				const read = await actual.readTreeOffThread(questsRoot);
				signing.onRead?.();
				if (signing.gate) await signing.gate;
				return read;
			},
		};
	},
);

/** Hold every signing's findings until the returned call opens them. */
function holdSignings(): () => void {
	let open = (): void => undefined;
	signing.gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	return open;
}

/** Resolves once the next signing off the thread has read the tree. */
function nextRead(): Promise<void> {
	return new Promise<void>((resolve) => {
		signing.onRead = resolve;
	});
}

const reads = vi.mocked(fs.readFileSync);
const listings = vi.mocked(fs.readdirSync);
const reals = vi.mocked(fs.realpathSync);
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

/** The calls that held the thread, but a stat of each folder in `but`. */
function syncCalls(but: readonly string[] = []): unknown[] {
	return [
		...reads.mock.calls,
		...listings.mock.calls,
		...reals.mock.calls,
		...stats.mock.calls.filter(([path]) => !but.includes(String(path))),
	];
}

function clearCalls(): void {
	reads.mockClear();
	listings.mockClear();
	reals.mockClear();
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

let openSignings: (() => void) | undefined;

afterEach(() => {
	openSignings?.();
	openSignings = undefined;
	signing.gate = undefined;
	signing.onRead = undefined;
	vi.useRealTimers();
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
		later(6_000);
		expect(statusNow()).toBe("active");
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("signs off the thread with no call that holds it, nested quests and README-less folders too", async () => {
		const nested = join(root, ID, OTHER);
		mkdirSync(nested);
		settle(nested);
		const bare = join(root, "QEST-20260604-DDD444");
		mkdirSync(bare);
		settle(bare);
		settle(join(root, ID));
		settle(root);
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		later(6_000);
		discoverQuests(root);
		clearCalls();
		await discoverySettled(root);
		expect(syncCalls([bare])).toEqual([]);
		expect(statusNow()).toBe("paused");
	});

	it("starts no second signing within a few seconds of the last", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		discoverQuests(root);
		await discoverySettled(root);
		expect(statusNow()).toBe("active");
	});

	it("signs on the thread at an ask after a minute unasked", () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		later(61_000);
		expect(statusNow()).toBe("paused");
	});

	it("starts no signing four seconds on", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		later(4_000);
		discoverQuests(root);
		await discoverySettled(root);
		expect(statusNow()).toBe("active");
	});

	it("answers no walk of a root changed too lately for its stat to vouch", () => {
		const now = new Date();
		utimesSync(root, now, now);
		discoverQuests(root);
		clearCalls();
		discoverQuests(root);
		expect(listings.mock.calls.length).toBeGreaterThan(0);
	});

	it("drops a signing begun before one on the thread that answered since", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		writeSettled(readmePath, readme("paused"));
		later(1_000);
		signQuestsNow(root);
		openSignings();
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("gives up on a signing whose disk never answers, and starts another", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		openSignings = holdSignings();
		later(6_000);
		discoverQuests(root);
		const hung = discoverySettled(root);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await hung).toBe("gave up");
		later(6_000);
		discoverQuests(root);
		expect(discoverySettled(root)).not.toBe(hung);
	});

	it("starts one signing at a time for a root", async () => {
		discoverQuests(root);
		later(6_000);
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
		settle(join(root, OTHER));
		settle(root);
		expect(questIds()).not.toContain(OTHER);
		expect(questIds()).not.toContain(OTHER);
		writeSettled(
			join(root, OTHER, "README.md"),
			readme("active").replaceAll(ID, OTHER),
		);
		expect(questIds()).toContain(OTHER);
	});

	it("finds a quest whose empty README was filled in place at once", () => {
		const empty = join(root, OTHER, "README.md");
		mkdirSync(join(root, OTHER));
		writeSettled(empty, "");
		settle(join(root, OTHER));
		settle(root);
		expect(questIds()).not.toContain(OTHER);
		expect(questIds()).not.toContain(OTHER);
		writeSettled(empty, readme("active").replaceAll(ID, OTHER));
		expect(questIds()).toContain(OTHER);
	});

	it("drops a quest removed elsewhere at once", () => {
		otherQuest();
		discoverQuests(root);
		rmSync(join(root, OTHER), { recursive: true });
		expect(questIds()).not.toContain(OTHER);
	});

	it("shows this process's write made while a signing ran", async () => {
		discoverQuests(root);
		later(6_000);
		discoverQuests(root);
		atomicWriteFile(readmePath, readme("paused"));
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
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
