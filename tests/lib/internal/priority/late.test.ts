import { describe, expect, it } from "vitest";
import { lateNow, lateSaid } from "../../../../lib/internal/priority/late.ts";
import type {
	Job,
	Room,
	WaitReason,
} from "../../../../lib/internal/priority/queue.ts";
import { job, NOW, ROOMY } from "./queue-line.ts";

/** Jobs a minute waiting that were due at once, so any reason makes one late. */
const due = (id: string, over: Partial<Job> = {}) =>
	job(id, { dueToStart: NOW - 60_000, ...over });

/** What each of `jobs` is told, by id, judged by `reasons` on `room`. */
const told = (
	jobs: readonly Job[],
	reasons: Record<string, WaitReason>,
	room: Room = ROOMY,
) =>
	Object.fromEntries(
		[...lateNow(jobs, new Map(Object.entries(reasons)), room, NOW)].map(
			([id, late]) => [id, late.heldBy],
		),
	);

describe("what holds a late job, as its waiter is told", () => {
	it("names the job ahead that keeps the line, past those only waiting their turn", () => {
		const jobs = [due("a", { what: "cargo build -p one" }), due("b"), due("c")];
		expect(told(jobs, { a: "memory", b: "order", c: "order" })).toMatchObject({
			b: "job a ahead of it (cargo build -p one), waiting on memory",
			c: "job a ahead of it (cargo build -p one), waiting on memory",
		});
		expect(told([due("a")], { a: "order" })).toEqual({
			a: "the time between turns, its own next",
		});
	});

	it("passes over a job ahead whose wait holds only itself", () => {
		const jobs = [
			due("a", { what: "nix build .#vm-test" }),
			due("b", { what: "cargo build -p two" }),
			due("c"),
		];
		expect(told(jobs, { a: "vms", b: "behind", c: "order" })).toMatchObject({
			c: "job b ahead of it (cargo build -p two), waiting behind a VM check",
		});
		expect(
			// Asked at once, the line takes them by id: a, then b, then c.
			told([due("a"), due("b"), due("c")], {
				a: "vms",
				b: "order",
				c: "order",
			}),
		).toMatchObject({ c: "the turn just given to a job ahead of it" });
	});

	it("says the reading that holds it, as the queue reads it", () => {
		const one = [due("a")];
		expect(
			told(one, { a: "busy" }, { ...ROOMY, cpuPressure: 81.26, ioPressure: 7 }),
		).toEqual({ a: "the machine's CPU (some avg10 81.3, IO 7)" });
		expect(
			told(one, { a: "busy" }, { ...ROOMY, floorsCpuPressure: 40 }),
		).toEqual({
			a: "the person's own programs waiting on CPU (some avg10 40)",
		});
		expect(told(one, { a: "vms" }, { ...ROOMY, vms: 3 })).toEqual({
			a: "the VMs allowed at once (3 running)",
		});
		expect(told(one, { a: "call" })).toEqual({
			a: "the person's call on this machine, during which only light work starts",
		});
	});

	it("passes over a job not yet due, started, or with nothing holding it", () => {
		const jobs = [
			due("soon", { dueToStart: NOW + 60_000 }),
			due("running", { started: new Date(NOW).toISOString() }),
			due("free"),
			due("told", {
				late: { at: "x", place: 1, reason: "memory", heldBy: "memory" },
			}),
		];
		expect(
			Object.keys(
				told(jobs, { soon: "memory", running: "memory", told: "memory" }),
			),
		).toEqual([]);
	});

	it("says its place as it is said aloud, and none while it plans", () => {
		const line = Array.from({ length: 22 }, (_, at) =>
			due(`j${String(at + 1).padStart(2, "0")}`),
		);
		const planning = due("plan", { planning: true });
		const jobs = [...line, planning];
		const reasons = new Map<string, WaitReason>(
			jobs.map((one) => [one.id, one.planning ? "planning" : "memory"]),
		);
		const late = lateNow(jobs, reasons, ROOMY, NOW);
		const placeOf = (id: string) => {
			const found = late.get(id);
			const asked = jobs.find((one) => one.id === id);
			if (found === undefined || asked === undefined) return undefined;
			return lateSaid(asked, found).split(": ")[1]?.split(",")[0];
		};
		expect(
			[
				"j01",
				"j02",
				"j03",
				"j04",
				"j11",
				"j12",
				"j13",
				"j21",
				"j22",
				"plan",
			].map(placeOf),
		).toEqual([
			"1st in line",
			"2nd in line",
			"3rd in line",
			"4th in line",
			"11th in line",
			"12th in line",
			"13th in line",
			"21st in line",
			"22nd in line",
			"not yet in line",
		]);
	});
});
