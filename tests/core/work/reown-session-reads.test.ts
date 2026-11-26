/**
 * A session resumed in a host re-owns its trees without reading every
 * record on the thread.
 *
 * Every conversation starting in a host re-owns its trees, and the record
 * folder holds thousands of records, most of them other sessions'. Read on
 * the thread, the listing held every conversation in the host while it
 * ran, once and again for each of the session's own records. These cases
 * pin that the listing goes off the thread and each record is read again
 * alone.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Owner, ProcessFacts } from "../../../lib/core/process/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { sessionHost } from "../../support/session-host.ts";

/** What the disk was asked on the thread. */
const thread = vi.hoisted(() => ({
	/** Each folder listed on the thread. */
	listed: [] as string[],
	/** Each file read on the thread. */
	read: [] as string[],
	/** A file whose read fails as a full descriptor table fails it. */
	faulty: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
		thread.listed.push(String(args[0]));
		return real.readdirSync(...args);
	}) as typeof real.readdirSync;
	const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
		thread.read.push(String(args[0]));
		if (String(args[0]) === thread.faulty)
			throw Object.assign(new Error("too many open files"), {
				code: "EMFILE",
			});
		return real.readFileSync(...args);
	}) as typeof real.readFileSync;
	const mocked = { ...real, readdirSync, readFileSync };
	return { ...mocked, default: mocked };
});

// Imported afresh: a setup file may already hold copies that read the
// real disk, before the one above stood in.
vi.resetModules();
const { createTreeMemory } = await import("../../../lib/core/work/memory.ts");
const { installHost } = await import("../../../lib/core/session/index.ts");

/** When the host that resumed the session started. */
const NOW = 5_000;

/** The session's entry from the host that ran it before the restart. */
const BEFORE = { pid: 4001, startedAt: 1000, session: "a", host: "test-host" };

/** Other sessions' records beside the session's own. */
const OTHERS = 20;

/** The machine after the restart: this process runs, the old host doesn't. */
const facts: ProcessFacts = {
	alive: (pid) => pid === process.pid,
	startedAt: async (pid) => (pid === process.pid ? NOW : undefined),
};

/** The session as it holds its trees after the restart. */
const US = {
	pid: process.pid,
	startedAt: NOW,
	session: "a",
	host: "test-host",
};

let root: string;
let removeHost: () => void;
/** Run once when the re-own first asks the host who it is, after its listing. */
let afterListing: (() => void) | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reown-reads-"));
	const { host } = sessionHost({ pid: process.pid, startedAt: NOW });
	const { owner } = host;
	Object.defineProperty(host, "owner", {
		get() {
			const run = afterListing;
			afterListing = undefined;
			run?.();
			return owner;
		},
	});
	removeHost = installHost(host);
});
afterEach(() => {
	afterListing = undefined;
	thread.faulty = undefined;
	removeHost();
	rmSync(root, { recursive: true, force: true });
});

/** Who each of the session's records names as holding it now, by key. */
function ownersIn(memory: ReturnType<typeof createTreeMemory>) {
	return Object.fromEntries(
		memory
			.recall()
			.filter(({ identity }) => identity.key.startsWith("ours-"))
			.map(({ identity, owners }) => [identity.key, owners]),
	);
}

/** A tree on disk whose record names `sessions`, held by `owners`. */
function tree(key: string, sessions: string[], ...owners: Owner[]): HeldTree {
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

describe("re-owning a resumed session's trees", () => {
	it("lists no record folder on the thread and reads only its own records there", async () => {
		const dir = join(root, "cut");
		const memory = createTreeMemory(dir);
		memory.remember(tree("ours-1", ["a"], BEFORE));
		memory.remember(tree("ours-2", ["a"], BEFORE));
		for (let at = 0; at < OTHERS; at += 1) {
			memory.remember(tree(`theirs-${at}`, ["b"], { ...BEFORE, session: "b" }));
		}
		thread.listed.length = 0;
		thread.read.length = 0;

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(2);
		expect(thread.listed.filter((one) => one === dir)).toEqual([]);
		expect(
			thread.read.filter((one) => one.startsWith(`${dir}/`)).sort(),
			"each of its own records is read on the thread once",
		).toEqual([join(dir, "ours-1.json"), join(dir, "ours-2.json")]);
		expect(ownersIn(memory)).toEqual({ "ours-1": [US], "ours-2": [US] });
	});

	it("keeps a holder that joined a tree after the listing", async () => {
		const dir = join(root, "cut");
		const memory = createTreeMemory(dir);
		memory.remember(tree("ours-1", ["a"], BEFORE));
		// Another conversation in this host takes the tree up meanwhile.
		const joined = { ...US, session: "b" };
		afterListing = () =>
			memory.remember(tree("ours-1", ["a", "b"], BEFORE, joined));

		await memory.reownSession("a", facts);

		expect(ownersIn(memory)).toEqual({ "ours-1": [joined, US] });
	});

	it("leaves a record it can't read under the lock as it was, re-owns the rest, and says so", async () => {
		const dir = join(root, "cut");
		const memory = createTreeMemory(dir);
		memory.remember(tree("ours-1", ["a"], BEFORE));
		memory.remember(tree("ours-2", ["a"], BEFORE));
		thread.faulty = join(dir, "ours-1.json");

		const reowning = memory.reownSession("a", facts);
		await expect(reowning).rejects.toThrow(
			"1 of its 2 records kept the old owner, since rewriting failed (too many open files)",
		);
		thread.faulty = undefined;

		expect(ownersIn(memory)).toEqual({ "ours-1": [BEFORE], "ours-2": [US] });
	});

	it("leaves a gone tree's record where it is", async () => {
		const dir = join(root, "cut");
		const memory = createTreeMemory(dir);
		memory.remember(tree("ours-1", ["a"], BEFORE));
		rmSync(join(root, "ours-1"), { recursive: true });

		const changed = await memory.reownSession("a", facts);

		expect(changed).toBe(0);
		expect(
			existsSync(join(dir, "ours-1.json")),
			"a gone tree's record is the sweep's to take, not the re-own's",
		).toBe(true);
	});
});
