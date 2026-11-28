import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	dir,
	folder,
	freshFolderEachTest,
	job,
	NOW,
	ROOMY,
	record,
	running,
	shellSays,
	TIGHT,
} from "./queue-folder.ts";

freshFolderEachTest();

const MINUTE_MS = 60_000;

/** A time as a late job's line says it: the machine's own hours. */
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/** What a job's `.late` holds, or nothing while it has none. */
const lateLine = (id: string) => {
	const file = join(dir, `${id}.late`);
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

/** A job as its file holds it now. */
const jobFile = (id: string) =>
	JSON.parse(readFileSync(join(dir, `${id}.job`), "utf8"));

/** A job as queue.json says it now. */
const recorded = (id: string) => record().jobs.find((one) => one.id === id);

/**
 * Three builds waiting on a machine with 1 GiB free, in this order:
 * `first`, asked without a due start, as an older harness asks, so due by its kind's
 * bound; `due`, due in 2 minutes; `later`, due in an hour.
 */
const waitingThree = () => {
	const queue = folder();
	queue.ask(job("first", { since: new Date(NOW - 2_000).toISOString() }));
	queue.ask(job("due", { dueToStart: NOW + 2 * MINUTE_MS }));
	queue.ask(job("later", { dueToStart: NOW + 60 * MINUTE_MS }));
	shellSays("first", 601);
	shellSays("due", 602);
	shellSays("later", 603);
	queue.keep(TIGHT, NOW, () => undefined);
	return queue;
};

describe("the machine's queue folder telling a late job's waiter", () => {
	it("marks nothing before a job is due", () => {
		const queue = waitingThree();
		queue.keep(TIGHT, NOW + MINUTE_MS, () => undefined);
		for (const id of ["first", "due", "later"]) {
			expect(lateLine(id), id).toBeUndefined();
			expect(jobFile(id).late, id).toBeUndefined();
			expect(recorded(id)?.overdue, id).toBeUndefined();
		}
	});

	it("marks a job past its due start with where it stands and what holds it", () => {
		const queue = waitingThree();
		const found = NOW + 3 * MINUTE_MS;
		queue.keep(TIGHT, found, () => undefined);
		const late = {
			at: new Date(found).toISOString(),
			place: 2,
			reason: "order",
			heldBy: "job first ahead of it (cargo build), waiting on memory",
		};
		expect(jobFile("due").late).toEqual(late);
		expect(recorded("due")).toMatchObject({
			place: 2,
			waitingOn: "order",
			overdue: true,
			late,
		});
		expect(lateLine("due")).toBe(
			`Due to start by ${clock(NOW + 2 * MINUTE_MS)} and still waiting for its turn in the machine queue: 2nd in line, held by job first ahead of it (cargo build), waiting on memory.\n`,
		);
		expect(lateLine("first"), "first is due in 5 minutes").toBeUndefined();
		expect(lateLine("later"), "later is due in an hour").toBeUndefined();
	});

	it("marks an older harness's job past its kind's bound, by the reading that holds it", () => {
		const queue = waitingThree();
		queue.keep(TIGHT, NOW + 6 * MINUTE_MS, () => undefined);
		expect(recorded("first")).toMatchObject({
			overdue: true,
			late: {
				place: 1,
				reason: "memory",
				heldBy: "memory (some avg10 0, 1 GiB free of the 4 it needs)",
			},
		});
		expect(lateLine("first")).toBe(
			`Due to start by ${clock(NOW - 2_000 + 5 * MINUTE_MS)} and still waiting for its turn in the machine queue: 1st in line, held by memory (some avg10 0, 1 GiB free of the 4 it needs).\n`,
		);
	});

	it("says a late job overdue only until it starts", () => {
		const queue = waitingThree();
		queue.keep(TIGHT, NOW + 6 * MINUTE_MS, () => undefined);
		expect(recorded("first")?.overdue).toBe(true);
		queue.keep(ROOMY, NOW + 7 * MINUTE_MS, () => undefined);
		expect(jobFile("first").started, "first has its turn").toBeDefined();
		expect(recorded("first")?.overdue).toBeUndefined();
		expect(recorded("first")?.late).toBeUndefined();
	});

	it("tells each waiter once, however long it goes on waiting", () => {
		const queue = waitingThree();
		queue.keep(TIGHT, NOW + 3 * MINUTE_MS, () => undefined);
		const marked = jobFile("due").late;
		// Its shell read the line and the line went; no later keep says it again.
		rmSync(join(dir, "due.late"));
		queue.keep(TIGHT, NOW + 4 * MINUTE_MS, () => undefined);
		queue.keep(TIGHT, NOW + 10 * MINUTE_MS, () => undefined);
		expect(lateLine("due"), "a late job is told once").toBeUndefined();
		expect(jobFile("due").late).toEqual(marked);
		expect(recorded("due")?.late).toEqual(marked);
	});

	it("clears a late job's line with the rest of its files once its shell is gone", () => {
		const queue = waitingThree();
		queue.keep(TIGHT, NOW + 3 * MINUTE_MS, () => undefined);
		expect(lateLine("due"), "the line is written first").toBeDefined();
		running.delete(602);
		queue.keep(TIGHT, NOW + 4 * MINUTE_MS, () => undefined);
		expect(
			existsSync(join(dir, "due.late")),
			"a gone job's line is cleared",
		).toBe(false);
	});
});
