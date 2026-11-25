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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
		thread.listed.push(String(args[0]));
		return real.readdirSync(...args);
	}) as typeof real.readdirSync;
	const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
		thread.read.push(String(args[0]));
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

let root: string;
let removeHost: () => void;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reown-reads-"));
	const { host } = sessionHost({ pid: process.pid, startedAt: NOW });
	removeHost = installHost(host);
});
afterEach(() => {
	removeHost();
	rmSync(root, { recursive: true, force: true });
});

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
			[
				...new Set(thread.read.filter((one) => one.startsWith(`${dir}/`))),
			].sort(),
		).toEqual([join(dir, "ours-1.json"), join(dir, "ours-2.json")]);
	});
});
