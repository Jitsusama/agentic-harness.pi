import { describe, expect, it } from "vitest";
import {
	type Job,
	MOST_MEMORY_PRESSURE,
	nextTurn,
	waitingInOrder,
	waitReasons,
} from "../../../../lib/internal/priority/queue.ts";
import { CLASS_HOLDS_FOR_MS } from "../../../../lib/internal/priority/walk-order.ts";
import { job, NOW, ROOMY, startedAgo } from "./queue-line.ts";

describe("walks of World's objects by the class World's push gate ranks", () => {
	const walk = (id: string, agoMs: number, over: Partial<Job> = {}) =>
		job(id, {
			kind: "world-walk",
			what: "git fetch origin main",
			walk: "main-fetch",
			since: startedAgo(agoMs),
			...over,
		});
	const ids = (jobs: readonly Job[]) => jobs.map((one) => one.id);

	it("gives a class-0 walk asked after two class-1 walks the first turn once memory allows", () => {
		// 27 November, 17:24: a class-0 fetch waited 2052 s on memory
		// behind class-1 walks, so the gate's class never applied.
		const jobs = [
			walk("one", 9_000, { pushClass: 1 }),
			walk("two", 8_000, { pushClass: 1 }),
			walk("soonest", 1_000, { pushClass: 0 }),
		];
		const pressed = { ...ROOMY, memoryPressure: MOST_MEMORY_PRESSURE };
		expect(nextTurn(jobs, pressed, NOW)).toBeUndefined();
		expect([...waitReasons(jobs, pressed, NOW).values()]).toEqual([
			"memory",
			"memory",
			"memory",
		]);
		expect(ids(waitingInOrder(jobs, NOW))).toEqual(["soonest", "one", "two"]);
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("soonest");
	});

	it("keeps walks of one class in the order they asked, around a sooner class", () => {
		const jobs = [
			walk("later", 1_000, { pushClass: 1 }),
			walk("earlier", 9_000, { pushClass: 1 }),
			walk("soonest-later", 3_000, { pushClass: 0 }),
			walk("middle", 5_000, { pushClass: 1 }),
			walk("soonest", 7_000, { pushClass: 0 }),
		];
		expect(ids(waitingInOrder(jobs, NOW))).toEqual([
			"soonest",
			"soonest-later",
			"earlier",
			"middle",
			"later",
		]);
		const ones = jobs.filter((one) => one.pushClass === 1);
		expect(nextTurn(ones, ROOMY, NOW)?.id).toBe("earlier");
	});

	it("ranks a walk with no class, or one it can't read, as class 2", () => {
		// What an older harness wrote, or a job file another program wrote.
		const unread: Partial<Job> = JSON.parse('{"pushClass": 7}');
		const jobs = [
			walk("none", 9_000),
			walk("unread", 8_000, unread),
			walk("two", 7_000, { pushClass: 2 }),
			walk("one", 1_000, { pushClass: 1 }),
		];
		expect(ids(waitingInOrder(jobs, NOW))).toEqual([
			"one",
			"none",
			"unread",
			"two",
		]);
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("one");
	});

	it("still puts pushes and fetches of main ahead of other walks of one class", () => {
		const jobs = [
			walk("review", 9_000, { walk: "other", pushClass: 1 }),
			walk("push", 5_000, { walk: "push", pushClass: 1 }),
			walk("urgent-review", 1_000, { walk: "other", pushClass: 0 }),
		];
		expect(ids(waitingInOrder(jobs, NOW))).toEqual([
			"urgent-review",
			"push",
			"review",
		]);
	});

	it("waits a walk as class 0 once it has waited past the bound, so no stream of sooner classes holds it", () => {
		const reviews = [1, 2, 3].map((n) =>
			walk(`review-${n}`, n * 1_000, { walk: "other", pushClass: 1 }),
		);
		const push = (agoMs: number) =>
			walk("push", agoMs, { walk: "push", what: "git push" });
		const order = (agoMs: number) =>
			ids(waitingInOrder([push(agoMs), ...reviews], NOW));
		expect(order(CLASS_HOLDS_FOR_MS)).toEqual([
			"review-3",
			"review-2",
			"review-1",
			"push",
		]);
		expect(order(CLASS_HOLDS_FOR_MS + 1)).toEqual([
			"push",
			"review-3",
			"review-2",
			"review-1",
		]);
		const aged = [
			walk("fresh-soonest", 1_000, { pushClass: 0 }),
			walk("aged-one", CLASS_HOLDS_FOR_MS + 1, { pushClass: 1 }),
		];
		expect(ids(waitingInOrder(aged, NOW))).toEqual([
			"aged-one",
			"fresh-soonest",
		]);
		expect(nextTurn(aged, ROOMY, NOW)?.id).toBe("aged-one");
	});

	it("never puts a walk behind other work asked after it", () => {
		const jobs = [
			walk("later-class", 9_000, { pushClass: 2 }),
			job("asked-after", { since: startedAgo(8_000) }),
			walk("sooner-class", 7_000, { pushClass: 0 }),
			job("asked-last", { since: startedAgo(6_000) }),
		];
		expect(ids(waitingInOrder(jobs, NOW))).toEqual([
			"sooner-class",
			"later-class",
			"asked-after",
			"asked-last",
		]);
	});

	it("leaves other work its place, whatever class it carries", () => {
		const jobs = [
			job("build", { since: startedAgo(9_000) }),
			walk("bulk-walk", 8_000, { pushClass: 2 }),
			job("classed-build", { since: startedAgo(7_000), pushClass: 0 }),
			walk("soonest", 1_000, { pushClass: 0 }),
		];
		expect(ids(waitingInOrder(jobs, NOW))).toEqual([
			"build",
			"soonest",
			"bulk-walk",
			"classed-build",
		]);
		const builds = [
			job("old", { since: startedAgo(9_000), pushClass: 2 }),
			job("new", { since: startedAgo(1_000), pushClass: 0 }),
			job("timed", { kind: "benchmark", since: startedAgo(500), pushClass: 2 }),
		];
		expect(ids(waitingInOrder(builds, NOW))).toEqual(["timed", "old", "new"]);
		expect(nextTurn(builds, ROOMY, NOW)?.id).toBe("timed");
	});
});
