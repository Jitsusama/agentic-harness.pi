/**
 * Discovery on a host, where every conversation shares one thread.
 *
 * Signing the tree is a listing a folder and a stat a file, 6,072 calls
 * over 1,437 quests on 17 November, and on a host each one holds every
 * conversation while the disk answers. So a host answers a known tree
 * from its last signed walk and signs it again off the thread. What it
 * must show at once, its own writes and a quest made, removed or given
 * its README, it reads quest by quest: on 20 November a signing on the
 * thread for a write held 1,495 quests' host for 6.1 s. Plain pi signs
 * every ask, as before.
 *
 * Long because every case here counts the same thread's calls through
 * one fake filesystem, and splitting them would copy that counting.
 */

import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	type DiscoveryResult,
	discoverQuests,
	discoverQuestsAfresh,
	discoverySettled,
	readyQuests,
	refreshQuests,
} from "../../../../../lib/internal/quest/discovery/discovery.ts";
import { takeSeed } from "../../../../../lib/internal/quest/discovery-seed.ts";
import {
	atomicWriteFile,
	withQuestLock,
} from "../../../../../lib/internal/quest/io.ts";
import { installTestHost } from "../../../../support/session-host.ts";
import {
	ID,
	plan,
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
		lstatSync: vi.fn(actual.lstatSync),
	};
});

/**
 * A seam in the signing off the thread: `walks` counts those started
 * of this test's `root`, `onRead` hears when one's reads are done, and
 * `gate` holds what they found back until it opens, as a slow or hung
 * disk would. Each walk waits on the gate standing when its reads
 * ended. `keeps` counts the walks whose skipped records were kept, and
 * `fails` has the thread fail, as one that can't start or errs does.
 * Only this test's root counts and is heard, since a walk an earlier
 * test left running may end during this one.
 */
const signing = vi.hoisted(() => ({
	root: undefined as string | undefined,
	walks: 0,
	returned: 0,
	keeps: 0,
	fails: false,
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
			readTreeOffThread: async (questsRoot: string, hangsAfterMs: number) => {
				// Asked afresh at each step, since a walk an earlier test began
				// may read on into this one and must not be heard as its own.
				const ours = () => questsRoot === signing.root;
				if (ours()) signing.walks += 1;
				if (ours() && signing.fails) throw new Error("the thread failed");
				const read = await actual.readTreeOffThread(questsRoot, hangsAfterMs);
				if (ours()) signing.onRead?.();
				if (signing.gate) await signing.gate;
				if (ours()) signing.returned += 1;
				if (!read) return read;
				const keep = () => {
					if (ours()) signing.keeps += 1;
					read.keep();
				};
				return { ...read, keep };
			},
		};
	},
);

vi.mock(
	"../../../../../lib/internal/quest/discovery-seed.ts",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../../../lib/internal/quest/discovery-seed.ts")
			>();
		return { ...actual, takeSeed: vi.fn(actual.takeSeed) };
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
const linkStats = vi.mocked(fs.lstatSync);

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
		...[...stats.mock.calls, ...linkStats.mock.calls].filter(
			([path]) => !but.includes(String(path)),
		),
	];
}

/** The calls that held the thread on `dir` or anything inside it. */
function touching(dir: string): unknown[] {
	const inside = (path: unknown) =>
		String(path) === dir || String(path).startsWith(`${dir}/`);
	return [
		...reads.mock.calls,
		...listings.mock.calls,
		...reals.mock.calls,
		...stats.mock.calls,
		...linkStats.mock.calls,
	].filter(([path]) => inside(path));
}

/** The listings of the quests root itself. */
function rootListings(): unknown[] {
	return listings.mock.calls.filter(([path]) => String(path) === root);
}

/**
 * A quest write counted by a copy of io.ts that says nothing of where
 * it wrote, as one loaded before this code would.
 */
function unplacedWrite(): void {
	const count = globalThis as Record<symbol, number | undefined>;
	const writes = Symbol.for("agentic-harness.quest-writes");
	count[writes] = (count[writes] ?? 0) + 1;
}

function clearCalls(): void {
	reads.mockClear();
	listings.mockClear();
	reals.mockClear();
	stats.mockClear();
	linkStats.mockClear();
}

/**
 * What a walk found, in an order of its own: the quests with their
 * status, parent and documents, each parent's children, and the errors.
 */
function shapeOf({ index, errors }: DiscoveryResult): unknown {
	const byText = (a: string, b: string) => a.localeCompare(b);
	return {
		quests: [...index.quests.values()]
			.map((entry) => ({
				id: entry.doc.frontMatter.id,
				status: entry.doc.frontMatter.status,
				parent: entry.doc.frontMatter.parent ?? null,
				documents: entry.documents.map((doc) => doc.path).sort(byText),
			}))
			.sort((a, b) => byText(a.id, b.id)),
		children: [...index.children]
			.map(([parent, ids]) => [parent, [...ids].sort(byText)])
			.sort((a, b) => byText(String(a[0]), String(b[0]))),
		errors: errors
			.map((error) => `${error.path}: ${error.message}`)
			.sort(byText),
	};
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

/** A second quest beside the first, its folder and the root settled. */
function settledOther(): void {
	otherQuest();
	settle(join(root, OTHER));
	settle(root);
}

/** The second quest's status, as discovery answers it now. */
function otherStatus(): string | undefined {
	return discoverQuests(root).index.quests.get(OTHER)?.doc.frontMatter.status;
}

beforeEach(() => {
	({ root, readmePath } = settledTree());
	signing.root = root;
	clearDiscoveryCache();
	clearCalls();
});

let openSignings: (() => void) | undefined;

afterEach(() => {
	openSignings?.();
	openSignings = undefined;
	signing.gate = undefined;
	signing.onRead = undefined;
	signing.walks = 0;
	signing.returned = 0;
	signing.keeps = 0;
	signing.fails = false;
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

	it("answers an ask that can't wait from the last walk after a minute unasked, and signs again off the thread", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		later(61_000);
		clearCalls();
		expect(statusNow()).toBe("active");
		expect(syncCalls([root])).toEqual([]);
		await discoverySettled(root);
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

	it("keeps a quest read since a signing began over what that signing found", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		writeSettled(readmePath, readme("paused"));
		later(1_000);
		refreshQuests(root, [ID]);
		openSignings();
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("gives up on a signing whose disk never answers, and starts another once it hangs", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		openSignings = holdSignings();
		later(6_000);
		// Read before the clock moves, so the walk hangs on the gate, not
		// on a thread whose wall the fake clock would end.
		const read = nextRead();
		discoverQuests(root);
		await read;
		const hung = discoverySettled(root);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await hung).toBe("gave up");
		later(6_000);
		discoverQuests(root);
		expect(
			signing.walks,
			"no second walk starts beside one only given up on",
		).toBe(1);
		await vi.advanceTimersByTimeAsync(5 * 60_000 - 31_000);
		later(6_000);
		discoverQuests(root);
		expect(signing.walks, "nor just short of five minutes on").toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		later(6_000);
		discoverQuests(root);
		expect(signing.walks, "another walk starts once the first has hung").toBe(
			2,
		);
	});

	it("has an ask after another gave up wait on the same walk, and hear what it found", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		openSignings = holdSignings();
		later(6_000);
		const read = nextRead();
		discoverQuests(root);
		const first = discoverySettled(root);
		await read;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await first).toBe("gave up");
		const second = discoverySettled(root);
		openSignings();
		expect(await second).toBe("kept");
		expect(signing.walks, "both asks waited on one walk").toBe(1);
	});

	it("frees its root as soon as a walk given up on ends, and keeps what it found", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		openSignings = holdSignings();
		writeSettled(readmePath, readme("paused"));
		later(6_000);
		const read = nextRead();
		discoverQuests(root);
		const slow = discoverySettled(root);
		await read;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await slow).toBe("gave up");
		expect(statusNow(), "nothing is kept before the walk ends").toBe("active");
		openSignings();
		// Its read is real disk work, so the walk ends when it ends; a hung
		// walk's five minutes are far past what this waits.
		await vi.waitFor(() =>
			expect(statusNow(), "the slow walk's findings are kept").toBe("paused"),
		);
		later(6_000);
		discoverQuests(root);
		expect(
			signing.walks,
			"the next ask past its age starts a walk of its own",
		).toBe(2);
	});

	it("keeps the root of a walk begun after a hung one, when the hung one ends", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		const openHung = holdSignings();
		later(6_000);
		const firstRead = nextRead();
		discoverQuests(root);
		await firstRead;
		await vi.advanceTimersByTimeAsync(5 * 60_000 - 1_000);
		// A wait on the hung walk, with a clock of its own, that answers
		// once that walk has ended and let go of whatever it holds.
		const hungEnded = discoverySettled(root);
		await vi.advanceTimersByTimeAsync(1_000);
		openSignings = holdSignings();
		later(6_000);
		const secondRead = nextRead();
		discoverQuests(root);
		await secondRead;
		expect(signing.walks, "a second walk took the hung one's root").toBe(2);
		openHung();
		// The walk's end may wait on a timer of its own, so time moves on in
		// small steps, well inside the wait's 30 s clock, until it ends.
		let ended: Awaited<typeof hungEnded> | "waiting" = "waiting";
		void hungEnded.then((end) => {
			ended = end;
		});
		await vi.waitFor(
			async () => {
				await vi.advanceTimersByTimeAsync(100);
				expect(
					ended,
					`the hung walk ended (walks returned: ${signing.returned})`,
				).not.toBe("waiting");
			},
			{ timeout: 10_000 },
		);
		expect(ended, "the hung walk ended").not.toBe("gave up");
		later(6_000);
		discoverQuests(root);
		expect(
			signing.walks,
			"the hung walk's end leaves the second holding its root",
		).toBe(2);
	});

	it("puts back no record for a walk that ends after a later one was kept", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		const openHung = holdSignings();
		later(6_000);
		const firstRead = nextRead();
		discoverQuests(root);
		await firstRead;
		await vi.advanceTimersByTimeAsync(5 * 60_000 - 1_000);
		// A wait on the hung walk, with a clock of its own, that answers
		// once that walk has ended.
		const hungEnded = discoverySettled(root);
		await vi.advanceTimersByTimeAsync(1_000);
		signing.gate = undefined;
		later(6_000);
		discoverQuests(root);
		expect(await discoverySettled(root), "the later walk").toBe("kept");
		expect(signing.keeps, "the later walk kept its records").toBe(1);
		openHung();
		let ended: Awaited<typeof hungEnded> | "waiting" = "waiting";
		void hungEnded.then((end) => {
			ended = end;
		});
		await vi.waitFor(
			async () => {
				await vi.advanceTimersByTimeAsync(100);
				expect(ended, "the hung walk ended").not.toBe("waiting");
			},
			{ timeout: 4_000 },
		);
		expect(ended, "the hung walk was overtaken").toBe("dropped");
		expect(signing.keeps, "the overtaken walk kept nothing").toBe(1);
	});

	it("keeps the last walk when the thread fails, and says the signing failed", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		signing.fails = true;
		later(6_000);
		discoverQuests(root);
		expect(await discoverySettled(root)).toBe("failed");
		expect(signing.keeps, "a failed signing keeps nothing").toBe(0);
		expect(statusNow(), "the last walk stands").toBe("active");
	});

	it("starts one signing at a time for a root", async () => {
		discoverQuests(root);
		later(6_000);
		discoverQuests(root);
		const under = discoverySettled(root);
		discoverQuests(root);
		const beside = discoverySettled(root);
		await Promise.all([under, beside]);
		expect(signing.walks, "two asks at once start one walk").toBe(1);
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

	it("reads a named quest as it stands now, and no other", () => {
		settledOther();
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		clearCalls();
		refreshQuests(root, [ID]);
		expect(statusNow()).toBe("paused");
		expect(touching(join(root, OTHER))).toEqual([]);
		expect(rootListings()).toEqual([]);
	});

	it("reads only the quest it wrote to show its own write", () => {
		settledOther();
		discoverQuests(root);
		clearCalls();
		atomicWriteFile(readmePath, readme("paused"));
		expect(statusNow()).toBe("paused");
		expect(touching(join(root, OTHER))).toEqual([]);
		expect(rootListings()).toEqual([]);
	});

	it("lists only the root to find a quest made elsewhere", () => {
		discoverQuests(root);
		clearCalls();
		otherQuest();
		expect(questIds()).toContain(OTHER);
		expect(touching(join(root, ID))).toEqual([]);
	});

	it("lists only the root to drop a quest removed elsewhere", () => {
		settledOther();
		discoverQuests(root);
		rmSync(join(root, OTHER), { recursive: true });
		clearCalls();
		expect(questIds()).toEqual([ID]);
		expect(touching(join(root, ID))).toEqual([]);
	});

	it("signs nothing for a write outside any quest", () => {
		discoverQuests(root);
		const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
		try {
			atomicWriteFile(join(elsewhere, "record.json"), "{}\n");
			clearCalls();
			discoverQuests(root);
			expect(syncCalls([root])).toEqual([]);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("signs the tree again off the thread for a write it can't place", async () => {
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		unplacedWrite();
		clearCalls();
		discoverQuests(root);
		expect(touching(join(root, ID)), "read on the thread").toEqual([]);
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("signs again before a wait on the tree ends, for a write it can't place", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		const afresh = discoverQuestsAfresh(root);
		await read;
		writeSettled(readmePath, readme("paused"));
		unplacedWrite();
		openSignings();
		openSignings = undefined;

		const walk = await afresh;
		expect(walk.index.quests.get(ID)?.doc.frontMatter.status).toBe("paused");
	});

	it("parses a fresh memo's first signing from the last process's seed", async () => {
		vi.mocked(takeSeed).mockClear();
		await readyQuests(root, [], true);
		const seeded = vi.mocked(takeSeed).mock.calls.map(([of]) => of);
		expect(seeded, "seeds taken").toContain(root);
	});

	it("keeps a signing its own write overtook, and shows both", async () => {
		settledOther();
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		writeSettled(
			join(root, OTHER, "README.md"),
			readme("paused").replaceAll(ID, OTHER),
		);
		discoverQuests(root);
		await read;
		atomicWriteFile(readmePath, readme("paused"));
		openSignings();
		openSignings = undefined;
		await discoverySettled(root);
		clearCalls();
		expect(otherStatus(), "what the signing found").toBe("paused");
		expect(statusNow(), "the write it overtook").toBe("paused");
		expect(touching(join(root, OTHER))).toEqual([]);
		expect(signing.walks, "walks of the tree").toBe(1);
	});

	it("reads the root's entry again for a write misplaced in a quest inside another", () => {
		discoverQuests(root);
		const nested = join(root, ID, OTHER);
		mkdirSync(nested);
		atomicWriteFile(
			join(nested, "README.md"),
			readme("active").replaceAll(ID, OTHER),
		);
		const said = discoverQuests(root).errors.map((error) => error.message);
		expect(said.join("\n")).toContain("Nested quest");
	});

	it("keeps one copy of an entry's errors under a root named with a trailing slash", () => {
		const bare = join(root, "QEST-20260604-DDD444");
		mkdirSync(bare);
		settle(bare);
		settle(root);
		const slashed = `${root}/`;
		discoverQuests(slashed);
		atomicWriteFile(join(bare, "notes.txt"), "one\n");
		discoverQuests(slashed);
		atomicWriteFile(join(bare, "notes.txt"), "two\n");
		const { errors } = discoverQuests(slashed);
		const ofBare = errors.filter((error) => error.path.startsWith(bare));
		expect(ofBare.map((error) => error.message)).toEqual(["README.md missing"]);
	});

	it("reads a quest folder removed and put back under its name by the next signing", async () => {
		settledOther();
		discoverQuests(root);
		rmSync(join(root, OTHER), { recursive: true });
		mkdirSync(join(root, OTHER));
		writeSettled(
			join(root, OTHER, "README.md"),
			readme("paused").replaceAll(ID, OTHER),
		);
		settle(join(root, OTHER));
		discoverQuests(root);
		await discoverySettled(root);
		expect(otherStatus()).toBe("paused");
	});

	it("signs the tree again off the thread once more writes came than its log keeps", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
		try {
			discoverQuests(root);
			writeSettled(readmePath, readme("paused"));
			// The log keeps 4,096 writes: that many outside any quest are
			// placed, and read nothing again.
			for (let at = 0; at < 4_096; at++) withQuestLock(elsewhere, () => at);
			expect(statusNow(), "every write placed").toBe("active");
			for (let at = 0; at <= 4_096; at++) withQuestLock(elsewhere, () => at);
			clearCalls();
			discoverQuests(root);
			expect(touching(join(root, ID)), "read on the thread").toEqual([]);
			await discoverySettled(root);
			expect(statusNow(), "one past what the log keeps").toBe("paused");
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("has an action that names its quests read them, and wait on no signing", async () => {
		settledOther();
		discoverQuests(root);
		writeSettled(readmePath, readme("paused"));
		writeSettled(
			join(root, OTHER, "README.md"),
			readme("paused").replaceAll(ID, OTHER),
		);
		await readyQuests(root, [ID], false);
		expect(statusNow(), "the quest it names").toBe("paused");
		expect(otherStatus(), "a quest it doesn't").toBe("active");
		expect(signing.walks, "signings of the tree").toBe(0);
	});

	it("has an action across other quests wait on the whole tree signed afresh", async () => {
		settledOther();
		discoverQuests(root);
		writeSettled(
			join(root, OTHER, "README.md"),
			readme("paused").replaceAll(ID, OTHER),
		);
		await readyQuests(root, [ID], true);
		expect(otherStatus()).toBe("paused");
	});

	it("has an action after a minute unasked wait on the whole tree signed afresh", async () => {
		settledOther();
		discoverQuests(root);
		writeSettled(
			join(root, OTHER, "README.md"),
			readme("paused").replaceAll(ID, OTHER),
		);
		later(61_000);
		await readyQuests(root, [ID], false);
		expect(otherStatus()).toBe("paused");
	});

	it("has an action on a document the last walk never found wait on a signing", async () => {
		settledOther();
		discoverQuests(root);
		const id = "PLAN-20260604-CCC333";
		mkdirSync(join(root, OTHER, "plans"));
		writeSettled(
			join(root, OTHER, "plans", `${id}.md`),
			plan("Made Elsewhere", id).replaceAll(ID, OTHER),
		);
		await readyQuests(root, [id], false);
		const quest = discoverQuests(root).index.quests.get(OTHER);
		expect(quest?.documents.map((doc) => doc.path)).toContain(
			join(root, OTHER, "plans", `${id}.md`),
		);
	});

	it("brings a walk up to date as a whole walk of the tree finds it", () => {
		settledOther();
		discoverQuests(root);
		const third = "QEST-20260604-EEE555";
		atomicWriteFile(
			join(root, OTHER, "README.md"),
			readme("paused")
				.replaceAll(ID, OTHER)
				.replace("parent: null", `parent: ${ID}`),
		);
		mkdirSync(join(root, third));
		atomicWriteFile(
			join(root, third, "README.md"),
			readme("active").replaceAll(ID, third),
		);
		mkdirSync(join(root, "QEST-20260604-DDD444"));
		atomicWriteFile(
			join(root, ID, "plans", "PLAN-20260604-CCC333.md"),
			plan("Another", "PLAN-20260604-CCC333"),
		);
		const caught = shapeOf(discoverQuests(root));
		host?.dispose();
		host = undefined;
		clearDiscoveryCache();
		expect(caught).toEqual(shapeOf(discoverQuests(root)));
	});

	it("brings a walk up to date through removals as a whole walk finds it", () => {
		settledOther();
		const plans = join(root, ID, "plans");
		mkdirSync(plans, { recursive: true });
		const planFile = join(plans, "PLAN-20260604-CCC333.md");
		atomicWriteFile(planFile, plan("Another", "PLAN-20260604-CCC333"));
		discoverQuests(root);
		atomicWriteFile(
			join(root, OTHER, "README.md"),
			readme("paused").replaceAll(ID, OTHER),
		);
		discoverQuests(root);
		rmSync(planFile);
		atomicWriteFile(readmePath, readme("blocked"));
		rmSync(join(root, OTHER), { recursive: true, force: true });
		const caught = shapeOf(discoverQuests(root));
		host?.dispose();
		host = undefined;
		clearDiscoveryCache();
		expect(caught).toEqual(shapeOf(discoverQuests(root)));
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
