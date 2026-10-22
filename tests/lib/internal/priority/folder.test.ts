import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HEARTBEAT_MS,
	PID_MS,
	type QueueRecord,
	queueFolder,
} from "../../../../lib/internal/priority/folder.ts";
import type { Job } from "../../../../lib/internal/priority/queue.ts";
import type { Reading } from "../../../../lib/internal/priority/room.ts";

const NOW = Date.parse("2026-10-22T16:00:30Z");
const ROOMY: Reading = {
	availableGib: 40,
	memoryPressure: 0,
	cores: 16,
	pressure: { cpu: 1, memory: 0, io: 0 },
};
const TIGHT: Reading = { ...ROOMY, availableGib: 1 };

let dir: string;
let running: Set<number>;
beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "queue-")), "jobs");
	running = new Set([100]);
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const folder = () =>
	queueFolder(dir, {
		isRunning: (pid) => running.has(pid),
		cgroupOf: (pid) => `/jobs.slice/jobs.service#${pid}`,
	});

function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		kind: "build",
		what: "cargo build",
		owner: { session: "session-a", pid: 100 },
		since: new Date(NOW - 1_000).toISOString(),
		...over,
	};
}

const record = () =>
	JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as QueueRecord;

const shellSays = (id: string, pid: number) => {
	running.add(pid);
	writeFileSync(join(dir, `${id}.pid`), `${pid}\n`);
};

describe("the machine's queue folder", () => {
	it("gives the first job its turn and shows the queue whole", () => {
		const queue = folder();
		queue.ask(job("first", { kind: "vm-test" }));
		queue.ask(job("second"));
		shellSays("first", 200);
		queue.keep(ROOMY, NOW, (one) =>
			one.kind === "vm-test" ? "/timed" : undefined,
		);
		expect(queue.hasTurn("first")).toBe(true);
		expect(readFileSync(join(dir, "first.turn"), "utf8")).toBe("/timed");
		expect(queue.hasTurn("second")).toBe(false);
		const shown = record();
		expect(shown.heartbeat).toBe(NOW / 1000);
		expect(shown.machine).toEqual({
			cores: 16,
			availableGib: 40,
			pressure: ROOMY.pressure,
		});
		expect(shown.jobs).toEqual([
			{
				id: "first",
				class: "timed",
				kind: "vm-test",
				state: "running",
				owner: { session: "session-a", pid: 100 },
				what: "cargo build",
				memoryGib: 6,
				since: new Date(NOW).toISOString(),
				slice: "/jobs.slice/jobs.service#200",
			},
			{
				id: "second",
				class: "bulk",
				kind: "build",
				state: "waiting",
				owner: { session: "session-a", pid: 100 },
				what: "cargo build",
				memoryGib: 4,
				since: new Date(NOW - 1_000).toISOString(),
				place: 1,
			},
		]);
	});

	it("gives up jobs whose shell or session has ended", () => {
		const queue = folder();
		queue.ask(job("finished"));
		shellSays("finished", 300);
		running.delete(300);
		queue.ask(
			job("unsaid", { since: new Date(NOW - PID_MS - 1).toISOString() }),
		);
		queue.ask(job("orphaned", { owner: { session: "gone", pid: 999 } }));
		queue.ask(job("kept"));
		queue.keep(TIGHT, NOW, () => undefined);
		expect(record().jobs.map((one) => one.id)).toEqual(["kept"]);
		expect(existsSync(join(dir, "finished.pid"))).toBe(false);
		expect(existsSync(join(dir, "unsaid.job"))).toBe(false);
	});

	it("leaves the queue to a session keeping it, until its lock is stale", () => {
		const queue = folder();
		queue.ask(job("first", { since: new Date().toISOString() }));
		const lock = join(dir, "queue.lock");
		mkdirSync(lock);
		queue.keep(ROOMY, Date.now(), () => undefined);
		expect(queue.hasTurn("first")).toBe(false);
		const old = (Date.now() - 11_000) / 1000;
		utimesSync(lock, old, old);
		queue.keep(ROOMY, Date.now(), () => undefined);
		expect(queue.hasTurn("first")).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	it("counts each minute a job waited with its memory free, once", () => {
		const queue = folder();
		// Two VMs run, so a third waits on the limit with its memory free.
		const ran = new Date(NOW - 120_000).toISOString();
		queue.ask(job("vm1", { kind: "vm-check", started: ran }));
		queue.ask(job("vm2", { kind: "vm-check", started: ran }));
		queue.ask(job("held", { kind: "vm-test" }));
		for (const [id, pid] of [
			["vm1", 401],
			["vm2", 402],
			["held", 403],
		] as const) {
			shellSays(id, pid);
		}
		queue.keep(ROOMY, NOW, () => undefined);
		expect(record().wasted.today).toBe(1);
		queue.keep(ROOMY, NOW + 10_000, () => undefined);
		expect(record().wasted.today).toBe(1);
		queue.keep(ROOMY, NOW + 60_000, () => undefined);
		expect(record().wasted.today).toBe(2);
		queue.keep(TIGHT, NOW + 120_000, () => undefined);
		expect(record().wasted.today).toBe(2);
		queue.keep(ROOMY, Date.parse("2026-10-23T00:00:10Z"), () => undefined);
		expect(record().wasted).toEqual({
			today: 1,
			day: "2026-10-23",
			minute: "2026-10-23T00:00",
		});
	});

	it("writes queue.json when it changes or its heartbeat is due", () => {
		const queue = folder();
		queue.ask(job("waiting"));
		shellSays("waiting", 501);
		queue.keep(TIGHT, NOW, () => undefined);
		const first = record().heartbeat;
		queue.keep(TIGHT, NOW + HEARTBEAT_MS - 1, () => undefined);
		expect(record().heartbeat).toBe(first);
		expect(queue.isDue(statSync(join(dir, "queue.json")).mtimeMs + 1)).toBe(
			false,
		);
		queue.keep(TIGHT, NOW + HEARTBEAT_MS, () => undefined);
		expect(record().heartbeat).toBe(first + HEARTBEAT_MS / 1000);
		queue.ask(job("another"));
		shellSays("another", 502);
		queue.keep(TIGHT, NOW + HEARTBEAT_MS + 1_000, () => undefined);
		expect(record().jobs).toHaveLength(2);
		expect(queue.hasJobs()).toBe(true);
	});
});
