/**
 * Signing the quest tree off the host's thread. A host's one thread
 * runs every conversation's work, often for seconds at a stretch; on
 * 20 November signing 1,523 quests took 30 to 76 s there, since each of
 * its thousands of reads waited for a turn, and every write resting on
 * a signing was refused. These hold that a busy thread holds back the
 * reads by no more than the one turn it takes to hear them, and that
 * what is read is what the walk needs.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearDiscoveryCache } from "../../../../../lib/internal/quest/discovery/discovery.ts";
import { readTreeOffThread } from "../../../../../lib/internal/quest/discovery/off-thread.ts";
import { plan, settle, writeSettled } from "../support/discovery-tree.ts";

/** How many quests the busy-thread tree holds, each with a plan. */
const QUESTS = 200;

/** How long the thread is held, as a conversation's turn may hold it. */
const HELD_MS = 3_000;

/** The turns the thread is given after it is let go. */
const TURNS_AFTER = 5;

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

/** A settled tree of `count` quests, each with a README and a plan. */
function treeOf(count: number): string {
	const root = mkdtempSync(join(tmpdir(), "disc-thread-"));
	roots.push(root);
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

describe("readTreeOffThread", () => {
	it("is read while the host's thread is held", async () => {
		const root = treeOf(QUESTS);
		let read = false;
		const reading = readTreeOffThread(root).then((answer) => {
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
		const { pass, rootStamp } = await readTreeOffThread(root);
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
		expect(pass.pending.get(dir)).toMatch(/\|/);
		expect(pass.reals.get(dir)).toBe(dir);
	});

	it("doesn't read a file again whose stamp still vouches", async () => {
		const root = treeOf(1);
		const notes = join(root, questId(0), "plans", "notes.txt");
		writeSettled(notes, "kept");
		settle(join(root, questId(0), "plans"));
		const first = await readTreeOffThread(root);
		const second = await readTreeOffThread(root);
		expect(first.pass.bytes.has(notes), "first read reads it").toBe(true);
		expect(second.pass.bytes.has(notes), "second read skips it").toBe(false);
		expect(second.pass.hashes.get(notes)).toBe(first.pass.hashes.get(notes));
	});

	it("reads a file again once it changes", async () => {
		const root = treeOf(1);
		const notes = join(root, questId(0), "plans", "notes.txt");
		writeSettled(notes, "before");
		const first = await readTreeOffThread(root);
		writeSettled(notes, "after, and longer");
		const second = await readTreeOffThread(root);
		expect(second.pass.bytes.get(notes)?.toString()).toBe("after, and longer");
		expect(second.pass.hashes.get(notes)).not.toBe(
			first.pass.hashes.get(notes),
		);
	});

	it("reads no tree where none is, and says nothing stamps it", async () => {
		const parent = mkdtempSync(join(tmpdir(), "disc-thread-"));
		roots.push(parent);
		const root = join(parent, "none");
		const { pass, rootStamp } = await readTreeOffThread(root);
		expect(rootStamp).toBeUndefined();
		expect(pass.listings.get(root)).toBeUndefined();
		expect(pass.hashes.size).toBe(0);
	});
});
