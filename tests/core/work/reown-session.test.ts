/**
 * A session that starts again names its new process on its trees.
 *
 * A record names its holders by process, but a session outlives its
 * process, so after a host restart the records of the trees it holds name
 * a process that has gone. Anything judging a tree by its owners then
 * reads it as abandoned. These cases pin what re-owning keeps and what it
 * drops.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Owner, ProcessFacts } from "../../../lib/core/process/index.ts";
import { installHost } from "../../../lib/core/session/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import { sessionHost } from "../../support/session-host.ts";

/** When the host that resumed the session started. */
const NOW = 5_000;

/** The resumed session, as the record names it once re-owned. */
const US = {
	pid: process.pid,
	startedAt: NOW,
	session: "a",
	host: "test-host",
};

/** The session's entry from the host that ran it before the restart. */
const BEFORE = { pid: 4001, startedAt: 1000, session: "a", host: "test-host" };

/** The machine after the restart: this process runs, the old host doesn't. */
const facts = machine({ [process.pid]: NOW });

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

describe("a session resumed in a new host", () => {
	let removeHost: () => void;

	beforeEach(() => {
		const { host } = sessionHost({ pid: process.pid, startedAt: NOW });
		removeHost = installHost(host);
	});
	afterEach(() => {
		removeHost();
	});

	it("replaces its earlier entry and drops a gone holder", async () => {
		const memory = memoryAt();
		memory.remember(
			tree("ours", ["a"], BEFORE, { pid: 4003, startedAt: 3000 }),
		);

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(1);
		expect(memory.recall()[0]?.owners).toEqual([US]);
	});

	it("keeps the host's other conversation and a holder still running", async () => {
		const memory = memoryAt();
		const other = { ...US, session: "b" };
		const theirs = { pid: 4002, startedAt: 2000 };
		memory.remember(tree("shared", ["a", "b"], BEFORE, other, theirs));

		await memory.reownSession("a", machine({ 4002: 2000, [process.pid]: NOW }));

		expect(memory.recall()[0]?.owners).toEqual([other, theirs, US]);
	});

	it("leaves a subagent's tree that lists it only as the runner", async () => {
		// The lane's own process holds it; making the runner a holder too
		// would turn the lane's next job away from its own tree.
		const memory = memoryAt();
		const lane = { pid: 4004, startedAt: 4000 };
		memory.remember(tree("lane", ["lane", "a"], lane));

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(0);
		expect(memory.recall()[0]?.owners).toEqual([lane]);
	});

	it("leaves another session's tree", async () => {
		const memory = memoryAt();
		const theirs = { ...BEFORE, session: "b" };
		memory.remember(tree("theirs", ["b"], theirs));

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(0);
		expect(memory.recall()[0]?.owners).toEqual([theirs]);
	});

	it("writes nothing when the tree is already this process's", async () => {
		// A reload starts the session again in the same process.
		const memory = memoryAt();
		memory.remember(tree("ours", ["a"], US));

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(0);
		expect(memory.recall()[0]?.owners).toEqual([US]);
	});

	it("drops a gone holder left beside this process", async () => {
		const memory = memoryAt();
		memory.remember(tree("ours", ["a"], US, { pid: 4003, startedAt: 3000 }));

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(1);
		expect(memory.recall()[0]?.owners).toEqual([US]);
	});
});

describe("a plain pi session", () => {
	it("changes nothing, since its owners name no session", async () => {
		const memory = memoryAt();
		const gone = { pid: 4001, startedAt: 1000 };
		memory.remember(tree("ours", ["a"], gone));

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(0);
		expect(memory.recall()[0]?.owners).toEqual([gone]);
	});
});
