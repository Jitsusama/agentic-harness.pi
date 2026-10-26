/**
 * Custody of a tree under concurrency.
 *
 * Who holds a tree is what stops a release from deleting it under
 * somebody, so a holder lost from the record is a tree a live session
 * can have taken away. Two sessions rewriting one record at once is
 * how a holder gets lost, and two cuts of one tree at once is how a
 * session ends up holding the same tree twice.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTreeBroker,
	type HeldTree,
	type TreeProvider,
} from "../../../lib/core/work/broker.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import type { TreeRequest } from "../../../lib/core/work/tree.ts";

const CHILD = fileURLToPath(
	new URL("./support/custody-child.ts", import.meta.url),
);
const PRELOAD = fileURLToPath(
	new URL("../support/ts-source.mjs", import.meta.url),
);

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-custody-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Run a custody child to its end, failing on anything but a clean exit. */
function child(args: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const running = spawn(
			process.execPath,
			["--import", PRELOAD, CHILD, ...args],
			{
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		running.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		running.on("error", reject);
		running.on("exit", (code) => {
			if (code === 0 && running.pid !== undefined) resolve(running.pid);
			else reject(new Error(`custody child exited ${code}: ${stderr}`));
		});
	});
}

describe("sessions sharing one tree's record", () => {
	it("loses nobody when several rewrite it at once", async () => {
		const path = join(root, "tree");
		mkdirSync(path);
		const held: HeldTree = {
			identity: { key: "github:o/r@topic" } as HeldTree["identity"],
			path,
			providerId: "git",
		};
		const dir = join(root, "memory");
		const go = join(root, "go");
		const children = Array.from({ length: 6 }, () =>
			child([dir, JSON.stringify(held), "40", go]),
		);
		// Every child is up and waiting before any of them starts.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		writeFileSync(go, "");
		// Read the whole time, the way a release asking who else holds the
		// tree does, without the lock. Once the record exists nothing
		// here removes it, so any read that finds none caught a write
		// half done, and a release reading that would take the tree.
		let done = false;
		let seen = false;
		let torn = 0;
		const reading = (async () => {
			const reader = createTreeMemory(dir);
			while (!done) {
				const found = reader.recall().some((one) => one.path === path);
				if (found) seen = true;
				else if (seen) torn += 1;
				await new Promise((resolve) => setImmediate(resolve));
			}
		})();
		const pids = await Promise.all(children);
		done = true;
		await reading;

		const record = createTreeMemory(dir)
			.recall()
			.find((one) => one.path === path);
		const holders = (record?.owners ?? []).map((owner) => owner.pid);
		expect(holders.sort()).toEqual([...pids].sort());
		expect(seen).toBe(true);
		expect(torn).toBe(0);
	}, 60_000);
});

describe("two cuts of one tree at once", () => {
	it("are one cut after the other, and one tree held", async () => {
		let running = 0;
		let most = 0;
		const provider: TreeProvider = {
			id: "git",
			specificity: 0,
			appliesTo: () => true,
			async ensure(request: TreeRequest) {
				running += 1;
				most = Math.max(most, running);
				await new Promise((resolve) => setTimeout(resolve, 50));
				running -= 1;
				const path = join(root, "trees", request.purpose);
				mkdirSync(path, { recursive: true });
				return { path };
			},
			async release() {},
		};
		const broker = createTreeBroker({ providers: () => [provider] });
		const request: TreeRequest = {
			intent: "worktree",
			repo: { key: "github:o/r" },
			branch: "topic",
			purpose: "same",
		};

		const [one, two] = await Promise.all([
			broker.ensure(request),
			broker.ensure(request),
		]);

		expect(most).toBe(1);
		expect(two.path).toBe(one.path);
		expect(broker.held()).toHaveLength(1);
	});

	it("lets a cut waiting its turn be stopped", async () => {
		let calls = 0;
		const provider: TreeProvider = {
			id: "git",
			specificity: 0,
			appliesTo: () => true,
			async ensure(request: TreeRequest) {
				calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 200));
				const path = join(root, "trees", request.purpose);
				mkdirSync(path, { recursive: true });
				return { path };
			},
			async release() {},
		};
		const broker = createTreeBroker({ providers: () => [provider] });
		const request: TreeRequest = {
			intent: "worktree",
			repo: { key: "github:o/r" },
			branch: "topic",
			purpose: "same",
		};
		const stop = new AbortController();

		const first = broker.ensure(request);
		const second = broker.ensure(request, { signal: stop.signal });
		const settled = second.then(
			() => "cut",
			(error: Error) => error.name,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		stop.abort();

		expect(
			await Promise.race([
				settled,
				new Promise((resolve) =>
					setTimeout(() => resolve("still waiting"), 100),
				),
			]),
		).toBe("AbortError");
		await first;
		expect(calls).toBe(1);
	});
});
