/**
 * Signing the quest tree off the host's thread. A host's one thread
 * runs every conversation's work, often for seconds at a stretch; on
 * 20 November signing 1,523 quests took 30 to 76 s there, since each of
 * its thousands of reads waited for a turn, and every write resting on
 * a signing was refused. These hold that a busy thread holds back the
 * reads by no more than the one turn it takes to hear them, that what
 * is read is what the walk needs, and that the host reads nothing
 * itself once the thread has answered.
 */

import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../../lib/internal/quest/discovery/discovery.ts";
import {
	memo,
	settled,
} from "../../../../../lib/internal/quest/discovery/discovery-reads.ts";
import {
	pendingStampOf,
	type ReadOffThread,
	readTreeOffThread,
} from "../../../../../lib/internal/quest/discovery/off-thread.ts";
import {
	answerInThread,
	readTreeInThread,
} from "../../../../../lib/internal/quest/discovery/tree-thread.ts";
import {
	plan,
	settle,
	settledTree,
	writeSettled,
} from "../support/discovery-tree.ts";

/** How many quests the busy-thread tree holds, each with a plan. */
const QUESTS = 100;

/**
 * How long the thread is held, as a conversation's turn may hold it:
 * long beside the fraction of a second the thread takes to read the
 * tree, so a slow machine still lets it finish inside.
 */
const HELD_MS = 4_000;

/** The turns the thread is given after it is let go. */
const TURNS_AFTER = 5;

/** The wall a signing's thread reads within here: far past any test. */
const HANGS_AFTER_MS = 60_000;

const NS_PER_MS = 1_000_000n;

const roots: string[] = [];

afterEach(() => {
	clearDiscoveryCache();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function questId(n: number): string {
	return `QEST-20260604-${n.toString(36).toUpperCase().padStart(6, "0")}`;
}

function planId(n: number): string {
	return `PLAN-20260604-${n.toString(36).toUpperCase().padStart(6, "0")}`;
}

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "disc-thread-"));
	roots.push(dir);
	return dir;
}

/** A settled tree of `count` quests, each with a README and a plan. */
function treeOf(count: number): string {
	const root = scratch();
	for (let n = 0; n < count; n++) {
		const dir = join(root, questId(n));
		mkdirSync(join(dir, "plans"), { recursive: true });
		writeSettled(join(dir, "README.md"), `---\nid: ${questId(n)}\n---\n`);
		writeSettled(join(dir, "plans", `${planId(n)}.md`), plan("P", planId(n)));
		settle(join(dir, "plans"));
		settle(dir);
	}
	settle(root);
	return root;
}

/**
 * What the thread read of `root`, which the memo kept throughout, kept
 * as a signing nothing newer overtook is.
 */
async function readOf(root: string): Promise<ReadOffThread> {
	const read = await readTreeOffThread(root, HANGS_AFTER_MS);
	if (!read) throw new Error("the memo was let go while the tree was read");
	read.keep();
	return read;
}

/** Hold this thread as a long turn would, taking no turn in between. */
function holdTheThread(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// Spinning is the point: nothing else on this thread may run.
	}
}

function aTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** A program for a thread, written to a file of its own. */
function programOf(source: string): string {
	const path = join(scratch(), "program.mjs");
	writeFileSync(path, source);
	return path;
}

describe("readTreeOffThread", () => {
	it("is read while the host's thread is held", async () => {
		const root = treeOf(QUESTS);
		let read = false;
		const reading = readOf(root).then((answer) => {
			read = true;
			return answer;
		});
		holdTheThread(HELD_MS);
		for (let turn = 0; turn < TURNS_AFTER && !read; turn++) await aTurn();
		expect(read, "the tree was read while the thread was held").toBe(true);
		const { pass } = await reading;
		expect(pass.hashes.size).toBe(QUESTS * 2);
	}, 60_000);

	it("reads every listing, file and stamp the walk asks for", async () => {
		const root = treeOf(2);
		const { pass, rootStamp } = await readOf(root);
		const dir = join(root, questId(0));
		const planPath = join(dir, "plans", `${planId(0)}.md`);
		expect(rootStamp).toBeDefined();
		expect(
			pass.listings
				.get(root)
				?.map((e) => e.name)
				.sort(),
		).toEqual([questId(0), questId(1)]);
		const entry = pass.listings.get(dir)?.find((e) => e.name === "plans");
		expect(entry?.isDirectory(), "plans is listed as a folder").toBe(true);
		expect(entry?.isFile(), "plans is not listed as a file").toBe(false);
		expect(pass.listings.get(join(dir, "plans"))?.map((e) => e.name)).toEqual([
			`${planId(0)}.md`,
		]);
		expect(pass.bytes.get(planPath)?.toString()).toBe(plan("P", planId(0)));
		expect(pass.hashes.has(join(dir, "README.md")), "README hashed").toBe(true);
		expect(pass.pending.get(dir)).toBe(pendingStampOf(dir));
		expect(pass.pending.get(dir)).toMatch(/\|(?!none)/);
		expect(pass.reals.get(dir)).toBe(realpathSync(dir));
	});

	it("reads only the folders, links and files the walk reads", async () => {
		const root = treeOf(1);
		const dir = join(root, questId(0));
		const elsewhere = scratch();
		const brief = join(elsewhere, "BRIF-20260604-AAAAAA.md");
		writeSettled(brief, plan("B", "BRIF-20260604-AAAAAA"));
		symlinkSync(elsewhere, join(dir, "briefs"));
		mkdirSync(join(root, ".trash", questId(1)), { recursive: true });
		mkdirSync(join(root, "notes"));
		const other = join(root, questId(2));
		mkdirSync(join(other, "README.md"), { recursive: true });

		const { pass } = await readOf(root);

		expect(pass.reals.has(join(root, ".trash")), "a dot folder").toBe(false);
		expect(pass.listings.has(join(root, ".trash")), "a dot folder").toBe(false);
		expect(pass.reals.get(join(root, "notes"))).toBe(
			realpathSync(join(root, "notes")),
		);
		expect(pass.listings.has(join(root, "notes")), "not a quest").toBe(false);
		expect(
			pass.bytes.get(join(dir, "briefs", "BRIF-20260604-AAAAAA.md")),
			"a kind folder linked from elsewhere is read",
		).toBeDefined();
		expect(
			pass.absent.has(join(other, "README.md")),
			"a README that isn't a plain file is missing",
		).toBe(true);
	});

	it("doesn't read a file again whose stamp still vouches", async () => {
		const root = treeOf(1);
		const notes = join(root, questId(0), "plans", "notes.txt");
		writeSettled(notes, "kept");
		settle(join(root, questId(0), "plans"));
		const first = await readOf(root);
		const second = await readOf(root);
		expect(first.pass.bytes.has(notes), "first read reads it").toBe(true);
		expect(second.pass.bytes.has(notes), "second read skips it").toBe(false);
		expect(second.pass.hashes.get(notes)).toBe(first.pass.hashes.get(notes));
	});

	it("doesn't read again a README in a kind folder, which the walk only hashes", async () => {
		const root = treeOf(1);
		const inPlans = join(root, questId(0), "plans", "README.md");
		writeSettled(inPlans, "what these plans are");
		settle(join(root, questId(0), "plans"));
		const first = await readOf(root);
		const second = await readOf(root);
		expect(first.pass.bytes.has(inPlans), "first read reads it").toBe(true);
		expect(second.pass.bytes.has(inPlans), "second read skips it").toBe(false);
	});

	it("doesn't read again a document a walk parsed from what its stamp vouches for", async () => {
		const { root, planPath } = settledTree();
		roots.push(root);
		discoverQuests(root);
		const record = memo().documents.get(planPath);
		expect(record, "the walk parsed it").toBeDefined();
		const { pass } = await readOf(root);
		expect(pass.bytes.has(planPath), "not read again").toBe(false);
		expect(pass.hashes.get(planPath)).toBe(record?.hash);
	});

	it("reads again a file the walk parses once its record is gone", async () => {
		// Its stamp alone would leave the walk nothing to answer it from.
		const { root, readmePath, planPath } = settledTree();
		roots.push(root);
		discoverQuests(root);
		memo().documents.delete(planPath);
		memo().readmes.delete(readmePath);
		const { pass } = await readOf(root);
		expect(pass.bytes.has(planPath), "the plan is read").toBe(true);
		expect(pass.bytes.has(readmePath), "the README is read").toBe(true);
	});

	it("reads a file again once it changes", async () => {
		const root = treeOf(1);
		const notes = join(root, questId(0), "plans", "notes.txt");
		writeSettled(notes, "before");
		const first = await readOf(root);
		writeSettled(notes, "after, and longer");
		const second = await readOf(root);
		expect(second.pass.bytes.get(notes)?.toString()).toBe("after, and longer");
		expect(second.pass.hashes.get(notes)).not.toBe(
			first.pass.hashes.get(notes),
		);
	});

	it("keeps the record of a README it skipped, though a walk let it go meanwhile", async () => {
		const { root, readmePath } = settledTree();
		roots.push(root);
		discoverQuests(root);
		const record = memo().readmes.get(readmePath);
		expect(record, "the walk parsed it").toBeDefined();

		const reading = readOf(root);
		memo().readmes.delete(readmePath);
		const { pass } = await reading;

		expect(pass.bytes.has(readmePath), "not read again").toBe(false);
		expect(pass.hashes.get(readmePath)).toBe(record?.hash);
		expect(memo().readmes.get(readmePath)).toBe(record);
	});

	it("answers a skipped README by the record a walk parsed while it read", async () => {
		const { root, readmePath } = settledTree();
		roots.push(root);
		discoverQuests(root);
		const record = memo().readmes.get(readmePath);
		if (!record) throw new Error("the walk parsed no README");

		const reading = readOf(root);
		const newer = { ...record, hash: "a later write's hash" };
		memo().readmes.set(readmePath, newer);
		const { pass } = await reading;

		expect(pass.bytes.has(readmePath), "not read again").toBe(false);
		expect(
			pass.hashes.get(readmePath),
			"the hash the walk finds its record under, so it reads nothing",
		).toBe(newer.hash);
		expect(memo().readmes.get(readmePath)).toBe(newer);
	});

	it("puts nothing back for a signing that isn't kept", async () => {
		const { root, readmePath } = settledTree();
		roots.push(root);
		discoverQuests(root);
		expect(memo().readmes.has(readmePath), "the walk parsed it").toBe(true);

		const reading = readTreeOffThread(root, HANGS_AFTER_MS);
		memo().readmes.delete(readmePath);
		expect(await reading, "the memo was kept").toBeDefined();

		expect(
			memo().readmes.has(readmePath),
			"a walk's forgetting stands until the signing is kept",
		).toBe(false);
	});

	it("answers nothing when the memo is let go while it reads", async () => {
		const root = treeOf(1);
		discoverQuests(root);

		const reading = readTreeOffThread(root, HANGS_AFTER_MS);
		clearDiscoveryCache();

		expect(await reading).toBeUndefined();
	});

	it("reads no tree where none is, and says nothing stamps it", async () => {
		const root = join(scratch(), "none");
		const { pass, rootStamp } = await readOf(root);
		expect(rootStamp).toBeUndefined();
		expect(pass.listings.get(root)).toBeUndefined();
		expect(pass.hashes.size).toBe(0);
	});

	it("is refused, naming its root, when its thread doesn't answer in time", async () => {
		const root = treeOf(1);
		await expect(readTreeInThread(root, new Map(), 1)).rejects.toThrow(
			`reading ${root}: Error: no answer within 1 ms`,
		);
	});
});

describe("a stat's settling", () => {
	it("is judged by when the stat was taken, not when it is asked", () => {
		const now = BigInt(Date.now()) * NS_PER_MS;
		const written = now - 60_000n * NS_PER_MS;
		const stat = { size: 1n, mtimeNs: written, ctimeNs: written, ino: 1n };
		const second = 1_000n * NS_PER_MS;

		expect(
			settled({ ...stat, at: written + second }),
			"a file a second old when its stat was taken",
		).toBe(false);
		expect(
			settled({ ...stat, at: written + 3n * second }),
			"a file three seconds old when its stat was taken",
		).toBe(true);
	});
});

describe("answerInThread", () => {
	it("answers what the program first says", async () => {
		const program = programOf(
			'import { parentPort, workerData } from "node:worker_threads";\nparentPort.postMessage({ got: workerData });\n',
		);
		expect(await answerInThread(program, 7, HANGS_AFTER_MS)).toEqual({
			got: 7,
		});
	});

	it("is refused once its wall passes with no answer, and ends the thread", async () => {
		const program = programOf(
			'import { workerData } from "node:worker_threads";\nconst beats = new Int32Array(workerData);\nsetInterval(() => Atomics.add(beats, 0, 1), 10);\n',
		);
		const beats = new Int32Array(new SharedArrayBuffer(4));
		await expect(answerInThread(program, beats.buffer, 1_000)).rejects.toThrow(
			"no answer within 1000 ms",
		);
		expect(
			Atomics.load(beats, 0),
			"the thread had begun to beat",
		).toBeGreaterThan(0);
		// A thread's ending has no event here, and a loaded machine ends it
		// late, so the test watches until its beats hold still for twenty
		// beats' time: a thread left running never does.
		let last = Atomics.load(beats, 0);
		await vi.waitFor(
			async () => {
				// A real pause is the point: the beats it lets pass, or not.
				await new Promise((resolve) => setTimeout(resolve, 200));
				const now = Atomics.load(beats, 0);
				const still = now === last;
				last = now;
				expect(still, "the thread beats no more").toBe(true);
			},
			{ timeout: 4_000, interval: 0 },
		);
	});

	it("is refused when its program ends without answering", async () => {
		const program = programOf("process.exit(3);\n");
		await expect(answerInThread(program, null, HANGS_AFTER_MS)).rejects.toThrow(
			"the thread ended (3) unanswered",
		);
	});

	it("is refused with what its program threw", async () => {
		const program = programOf('throw new Error("the disk is on fire");\n');
		await expect(answerInThread(program, null, HANGS_AFTER_MS)).rejects.toThrow(
			"the disk is on fire",
		);
	});

	it("starts no thread while one is held in a read past its wall", async () => {
		// A FIFO with no writer holds its reader in the kernel, as a hung
		// disk does, where ending the thread can't reach it.
		const fifo = join(scratch(), "hung");
		execFileSync("mkfifo", [fifo]);
		const hangs = programOf(
			'import { readFileSync } from "node:fs";\nimport { parentPort, workerData } from "node:worker_threads";\nparentPort.postMessage(String(readFileSync(workerData)));\n',
		);
		await expect(answerInThread(hangs, fifo, 1_000)).rejects.toThrow(
			"no answer within 1000 ms",
		);
		const answers = programOf(
			'import { parentPort } from "node:worker_threads";\nparentPort.postMessage("here");\n',
		);
		await expect(
			answerInThread(answers, null, HANGS_AFTER_MS),
			"refused while the first is held",
		).rejects.toThrow("held in a read past its wall");

		// Open without waiting, so a reader not there fails rather than
		// holding this thread too.
		// Closing it unwritten lets the read return at its end.
		closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
		await vi.waitFor(
			async () =>
				expect(
					await answerInThread(answers, null, HANGS_AFTER_MS),
					"one starts once the read returns",
				).toBe("here"),
			{ timeout: 4_000 },
		);
	});
});
