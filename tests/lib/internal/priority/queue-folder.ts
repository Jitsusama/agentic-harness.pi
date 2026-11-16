/**
 * What the queue folder's tests share: a fresh folder for each test,
 * processes faked through the pids marked running, and a build to vary.
 *
 * `dir` and `running` are live bindings, so a test file that calls
 * {@link freshFolderEachTest} reads the current test's folder through
 * them, as when they were its own.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
	type QueueRecord,
	queueFolder,
} from "../../../../lib/internal/priority/folder.ts";
import type { Job } from "../../../../lib/internal/priority/queue.ts";
import type { Reading } from "../../../../lib/internal/priority/room.ts";

/** The moment every folder test is read at. */
export const NOW = Date.parse("2026-10-22T16:00:30Z");
/** A machine with memory free and next to no pressure. */
export const ROOMY: Reading = {
	availableGib: 40,
	memoryPressure: 0,
	vms: 0,
	cpuPressure: 1,
	cores: 16,
	pressure: { cpu: 1, memory: 0, io: 0 },
};
/** A machine with 1 GiB free. */
export const TIGHT: Reading = { ...ROOMY, availableGib: 1 };

/** The current test's queue folder. */
export let dir: string;
/** The pids the fake processes count as running. */
export let running: Set<number>;

/** Gives each test of the calling file a fresh folder and pid 100 running. */
export function freshFolderEachTest(): void {
	beforeEach(() => {
		dir = join(mkdtempSync(join(tmpdir(), "queue-")), "jobs");
		running = new Set([100]);
	});
	afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));
}

/** Processes as the folder reads them, running what {@link running} holds. */
export const processes = {
	isRunning: (pid: number) => running.has(pid),
	cgroupOf: (pid: number) => `/jobs.slice/jobs.service#${pid}`,
};

/** The current test's folder, kept with {@link processes}. */
export const folder = () => queueFolder(dir, processes);

/** A build asked a second ago, with `over` laid over it. */
export function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		kind: "build",
		what: "cargo build",
		owner: { session: "session-a", pid: 100 },
		since: new Date(NOW - 1_000).toISOString(),
		cappable: true,
		...over,
	};
}

/** queue.json as the current test's folder last wrote it. */
export const record = () =>
	JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as QueueRecord;

/** Says `pid` is the shell waiting to run job `id`, and runs it. */
export const shellSays = (id: string, pid: number) => {
	running.add(pid);
	writeFileSync(join(dir, `${id}.pid`), `${pid}\n`);
};
