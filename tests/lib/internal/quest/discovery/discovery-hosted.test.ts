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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
	discoverQuestsAfresh,
	discoverySettled,
	signingPausedPath,
	signQuestsNow,
} from "../../../../../lib/internal/quest/discovery/discovery.ts";
import { threadsLetGo } from "../../../../../lib/internal/quest/discovery/off-thread.ts";
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
 * A seam in the signing off the thread: `walks` counts those started
 * of this test's `root`, `onRead` hears when one's reads are done, and
 * `gate` holds what they found back until it opens, as a slow or hung
 * disk would. Each walk waits on the gate standing when its reads
 * ended. Only this test's root counts and is heard, since a walk an
 * earlier test left running may end during this one.
 */
const signing = vi.hoisted(() => ({
	root: undefined as string | undefined,
	walks: 0,
	returned: 0,
	onRead: undefined as (() => void) | undefined,
	gate: undefined as Promise<void> | undefined,
	letGo: false,
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
			// A thread let go that never stops, as on a disk that hangs for good.
			threadsLetGo: () =>
				signing.letGo
					? [new Promise<number>(() => undefined)]
					: actual.threadsLetGo(),
			readTreeOffThread: async (questsRoot: string, wallMs: number) => {
				// Asked afresh at each step, since a walk an earlier test began
				// may read on into this one and must not be heard as its own.
				const ours = () => questsRoot === signing.root;
				if (ours()) signing.walks += 1;
				const read = await actual.readTreeOffThread(questsRoot, wallMs);
				if (ours()) signing.onRead?.();
				if (signing.gate) await signing.gate;
				if (ours()) signing.returned += 1;
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

/** The one call an answer from the last walk makes: the root's stat. */
function rootStat(): unknown[] {
	return [[root, { bigint: true }]];
}

function clearCalls(): void {
	reads.mockClear();
	listings.mockClear();
	reals.mockClear();
	stats.mockClear();
}

/** Let `count` turns of the event loop pass, real ones, which fake timers leave be. */
async function turns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++)
		await new Promise((resolve) => setImmediate(resolve));
}

/** Turn the event loop until `holds` does, or fail after many turns. */
async function until(holds: () => boolean, most = 20_000): Promise<void> {
	for (let turn = 0; turn < most; turn++) {
		if (holds()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(`still waiting after ${most} turns: ${holds}`);
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
	signing.root = root;
	clearDiscoveryCache();
	clearCalls();
});

let openSignings: (() => void) | undefined;

afterEach(async () => {
	signing.letGo = false;
	// A wall fake time ran past lets its thread go, and while it stops no
	// signing starts: the next test's would fail at once.
	await Promise.all(threadsLetGo());
	openSignings?.();
	openSignings = undefined;
	signing.gate = undefined;
	signing.onRead = undefined;
	signing.walks = 0;
	signing.returned = 0;
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
		otherQuest();
		later(1_000);
		expect(questIds(), "a quest made shows at once").toContain(OTHER);
		openSignings();
		expect(await discoverySettled(root)).toBe("dropped");
		expect(questIds()).toContain(OTHER);
	});

	it("walks again for an action asked while a signing ran, rather than walk on the thread", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		writeSettled(readmePath, readme("paused"));
		clearCalls();
		signQuestsNow(root);
		expect(listings.mock.calls, "no walk on the thread").toEqual([]);
		signing.gate = undefined;
		openSignings();
		expect(await discoverySettled(root)).toBe("kept");
		expect(signing.walks, "walked again for the action").toBe(2);
		expect(statusNow()).toBe("paused");
	});

	it("gives up on a signing whose disk never answers, and starts another once it hangs", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		openSignings = holdSignings();
		later(6_000);
		// Its thread answers, so only the gate holds it, as a disk would.
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
		// Five minutes and the ten seconds' margin past the walk's start.
		await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000 - 31_000);
		later(6_000);
		discoverQuests(root);
		expect(signing.walks, "nor just short of its hung time").toBe(1);
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
		await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000 - 1_000);
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

	it("walks again at once rather than drop a walk this process wrote during", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		atomicWriteFile(readmePath, readme("paused"));
		signing.gate = undefined;
		openSignings();
		expect(await discoverySettled(root)).toBe("kept");
		expect(signing.walks, "walked again for the write").toBe(2);
		clearCalls();
		expect(statusNow()).toBe("paused");
		expect(
			syncCalls(),
			"answered from the walk signed after the write",
		).toEqual(rootStat());
	});

	it("answers from its last walk while a signing runs, its own write or none", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		atomicWriteFile(readmePath, readme("paused"));
		later(120_000);
		clearCalls();
		expect(statusNow(), "the walk under way brings the write").toBe("active");
		expect(syncCalls(), "nothing walked on the thread").toEqual(rootStat());
		signing.gate = undefined;
		openSignings();
		await discoverySettled(root);
		expect(statusNow()).toBe("paused");
	});

	it("keeps walking while writes overtake each walk, and never walks on the thread", async () => {
		discoverQuests(root);
		let overtaken = 0;
		const overtake = () => {
			if (overtaken >= 4) return;
			overtaken += 1;
			atomicWriteFile(readmePath, readme(overtaken < 4 ? "active" : "paused"));
			signing.onRead = overtake;
		};
		signing.onRead = overtake;
		later(6_000);
		clearCalls();
		discoverQuests(root);
		for (let ask = 0; ask < 4; ask++) {
			await new Promise((resolve) => setImmediate(resolve));
			later(120_000);
			discoverQuests(root);
		}
		expect(await discoverySettled(root)).toBe("kept");
		expect(signing.walks, "a walk for each write, and one past them").toBe(5);
		expect(statusNow()).toBe("paused");
		expect(listings.mock.calls, "no ask walked the tree on the thread").toEqual(
			[],
		);
	});

	it("walks nothing while the person has paused signing, its own writes neither, and resumes once the file goes", async () => {
		discoverQuests(root);
		const paused = signingPausedPath();
		mkdirSync(dirname(paused), { recursive: true });
		fs.writeFileSync(paused, "");
		try {
			atomicWriteFile(readmePath, readme("paused"));
			later(120_000);
			clearCalls();
			expect(statusNow(), "answered from the last walk").toBe("active");
			signQuestsNow(root);
			expect(signing.walks, "no walk off the thread").toBe(0);
			expect(syncCalls(), "nor on it").toEqual(rootStat());
			await expect(discoverQuestsAfresh(root)).rejects.toThrow(
				`signing is paused by ${paused}`,
			);
		} finally {
			rmSync(paused, { force: true });
		}
		later(6_000);
		expect(statusNow(), "resumed, its own write shows").toBe("paused");
	});

	it("walks nothing on the thread while a thread let go at its wall hasn't stopped", async () => {
		discoverQuests(root);
		signing.letGo = true;
		atomicWriteFile(readmePath, readme("paused"));
		later(120_000);
		clearCalls();
		expect(statusNow(), "answered from the last walk").toBe("active");
		signQuestsNow(root);
		expect(signing.walks, "no walk off the thread").toBe(0);
		expect(listings.mock.calls, "nor on it").toEqual([]);
		await expect(discoverQuestsAfresh(root)).rejects.toThrow();
		signing.letGo = false;
		expect(statusNow(), "once it stops, its own write shows").toBe("paused");
	});

	it("has an action wait for a walk begun after it asked, and see what changed", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		writeSettled(readmePath, readme("paused"));
		let answered = false;
		const asked = signQuestsNow(root).then(() => {
			answered = true;
		});
		await turns(20);
		expect(answered, "not answered by the walk begun before it").toBe(false);
		openSignings();
		await asked;
		expect(signing.walks, "a walk begun after it asked").toBe(2);
		expect(statusNow(), "and what changed shows").toBe("paused");
	});

	it("has an action that asks while a signing rests wake it, rather than wait out the rest", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		// Its own write during the walk asks for another, after a rest.
		atomicWriteFile(readmePath, readme("paused"));
		openSignings();
		await until(() => signing.returned === 1);
		await turns(20);
		expect(signing.walks, "resting, not walking").toBe(1);
		writeSettled(join(root, ID, "note.md"), "a note");
		const asked = signQuestsNow(root);
		await until(() => signing.walks === 2);
		await asked;
		expect(signing.walks, "woken at the ask, no fake time passing").toBe(2);
	});

	it("ends a signing walking again once the person pauses signing", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		const settled = discoverySettled(root);
		atomicWriteFile(readmePath, readme("paused"));
		const paused = signingPausedPath();
		mkdirSync(dirname(paused), { recursive: true });
		fs.writeFileSync(paused, "");
		try {
			// Past when the pause is read again.
			later(6_000);
			openSignings();
			expect(await settled).toBe("paused");
			expect(signing.walks, "no walk past the pause").toBe(1);
		} finally {
			rmSync(paused, { force: true });
		}
	});

	it("answers a wait for a fresh walk while writes keep overtaking the walks", async () => {
		discoverQuests(root);
		openSignings = holdSignings();
		const read = nextRead();
		later(6_000);
		discoverQuests(root);
		await read;
		writeSettled(readmePath, readme("paused"));
		const fresh = discoverQuestsAfresh(root);
		// Each walk is written during, so the signing walks on past this.
		const overtake = () => {
			atomicWriteFile(join(root, ID, "note.md"), `note ${signing.walks}`);
			signing.onRead = overtake;
		};
		signing.onRead = overtake;
		openSignings();
		const found = await fresh;
		signing.onRead = undefined;
		expect(found.index.quests.get(ID)?.doc.frontMatter.status).toBe("paused");
		expect(signing.walks, "answered by the walk after it asked").toBe(2);
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
