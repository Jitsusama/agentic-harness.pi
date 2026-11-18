/**
 * A session that starts again names its new process on its trees.
 *
 * A record names its holders by process, but a session outlives its
 * process, so after a restart the records of the trees it holds name a
 * process that has gone. Anything judging a tree by its owners then reads
 * it as abandoned. These cases pin what re-owning keeps and what it drops.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Owner, ProcessFacts } from "../../../lib/core/process/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";

/** When this process started, as the machine below reports it. */
const NOW = 5_000;

/** This process, as the record names it once re-owned. */
const US = { pid: process.pid, startedAt: NOW };

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reown-session-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const memoryAt = () => createTreeMemory(join(root, "cut"));

/** A tree on disk whose record names `sessions`, held by `owners`. */
function tree(key: string, sessions: string[], ...owners: Owner[]): HeldTree {
	// A real directory, since recall drops a record whose tree is gone.
	const path = join(root, key);
	mkdirSync(path, { recursive: true });
	return {
		identity: { key, shareable: true },
		path,
		providerId: "git",
		owners,
		sessions,
	};
}

/** A machine where these pids run, started at these times. */
function machine(running: Record<number, number>): ProcessFacts {
	return {
		alive: (pid) => pid in running,
		startedAt: async (pid) => running[pid],
	};
}

describe("a session starting again", () => {
	it("drops the gone process from its tree and names this one", async () => {
		const memory = memoryAt();
		memory.remember(tree("ours", ["ours"], { pid: 4001, startedAt: 1000 }));

		const changed = await memory.reownSession(
			"ours",
			machine({ [process.pid]: NOW }),
		);

		expect(changed).toBe(1);
		expect(memory.recall()[0]?.owners).toEqual([US]);
	});

	it("keeps another holder whose process still runs", async () => {
		const memory = memoryAt();
		const theirs = { pid: 4002, startedAt: 2000 };
		memory.remember(
			tree("shared", ["ours"], theirs, { pid: 4001, startedAt: 1000 }),
		);

		await memory.reownSession(
			"ours",
			machine({ 4002: 2000, [process.pid]: NOW }),
		);

		expect(memory.recall()[0]?.owners).toEqual([theirs, US]);
	});

	it("replaces its own earlier entry even while that process runs", async () => {
		// The entry naming this session is the session's own, from the
		// process it ran in before; two entries for one session would
		// keep the tree held after the session lets go.
		const memory = memoryAt();
		memory.remember(
			tree("ours", ["ours"], { pid: 4001, startedAt: 1000, session: "ours" }),
		);

		await memory.reownSession(
			"ours",
			machine({ 4001: 1000, [process.pid]: NOW }),
		);

		expect(memory.recall()[0]?.owners).toEqual([US]);
	});

	it("leaves a tree its records don't name it on", async () => {
		const memory = memoryAt();
		const gone = { pid: 4001, startedAt: 1000 };
		memory.remember(tree("theirs", ["theirs"], gone));

		const changed = await memory.reownSession(
			"ours",
			machine({ [process.pid]: NOW }),
		);

		expect(changed).toBe(0);
		expect(memory.recall()[0]?.owners).toEqual([gone]);
	});

	it("writes nothing when the tree is already this process's", async () => {
		// A reload starts the session again in the same process.
		const memory = memoryAt();
		memory.remember(tree("ours", ["ours"], US));

		const changed = await memory.reownSession(
			"ours",
			machine({ [process.pid]: NOW }),
		);

		expect(changed).toBe(0);
		expect(memory.recall()[0]?.owners).toEqual([US]);
	});

	it("leaves the record alone when the machine won't say when it started", async () => {
		const memory = memoryAt();
		const gone = { pid: 4001, startedAt: 1000 };
		memory.remember(tree("ours", ["ours"], gone));

		const changed = await memory.reownSession("ours", machine({}));

		expect(changed).toBe(0);
		expect(memory.recall()[0]?.owners).toEqual([gone]);
	});
});
