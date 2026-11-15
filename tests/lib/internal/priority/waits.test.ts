import { describe, expect, it } from "vitest";
import { NOBODY } from "../../../../lib/internal/priority/awaited.ts";
import {
	CAPS_BUILDS_FROM_CPU_PRESSURE,
	EVALUATION_GIB,
	type Job,
	MOST_CPU_PRESSURE_FOR_BUILDS,
	MOST_FLOORS_CPU_PRESSURE,
	MOST_FLOORS_PRESSURE,
	MOST_IO_PRESSURE_FOR_BUILDS,
	MOST_MEMORY_PRESSURE,
	MOST_VMS,
	nextTurn,
	PUSH_GIB,
	RAMP_MS,
	RULES,
	roomLeft,
	roomSaid,
	VM_SPREAD_MS,
	waitReasons,
	waitsWithRoom,
} from "../../../../lib/internal/priority/queue.ts";
import { BUSY, job, NOW, ROOMY, startedAgo } from "./queue-line.ts";

describe("why each job waits", () => {
	const long = startedAgo(RAMP_MS + 60_000);
	const older = (id: string, ms: number, over: Partial<Job> = {}) =>
		job(id, { since: startedAgo(ms), ...over });

	it("says memory when the memory a job needs isn't free, and order behind it", () => {
		const jobs = [older("big", 9_000), older("next", 8_000)];
		const tight = { ...ROOMY, availableGib: 1 };
		expect(nextTurn(jobs, tight, NOW)).toBeUndefined();
		expect(Object.fromEntries(waitReasons(jobs, tight, NOW))).toEqual({
			big: "memory",
			next: "order",
		});
	});

	it("says memory for everyone while the machine is short of it", () => {
		const jobs = [older("a", 9_000)];
		const pressed = { ...ROOMY, memoryPressure: MOST_MEMORY_PRESSURE };
		expect(waitReasons(jobs, pressed, NOW).get("a")).toBe("memory");
	});

	// 10 November: pushes of World that peaked at 3 MB and ran 3 to 14 s
	// waited 481 to 618 s on memory, booked as 6 GiB walks (WJATIN).
	it("gives a small push its quick turn ahead of a flake check, while memory is pressed", () => {
		const jobs = [
			older("check", 9_000, {
				what: "nix flake check",
				needsGib: EVALUATION_GIB,
			}),
			older("push", 8_000, {
				kind: "world-walk",
				walk: "push",
				what: "git push origin x",
				needsGib: PUSH_GIB,
				quick: true,
			}),
		];
		const pressed = {
			...ROOMY,
			availableGib: 8,
			memoryPressure: MOST_MEMORY_PRESSURE,
		};

		expect(nextTurn(jobs, pressed, NOW)?.id).toBe("push");
		expect(Object.fromEntries(waitReasons(jobs, pressed, NOW))).toEqual({
			check: "memory",
			push: "order",
		});
	});

	// A build's Nix builds are the daemon's, and outside what it was seen
	// to hold, so a quick build booked small may hold far more.
	it("holds a quick build while memory is pressed, however small it was booked", () => {
		const jobs = [older("quick", 9_000, { quick: true, needsGib: PUSH_GIB })];
		const pressed = { ...ROOMY, memoryPressure: MOST_MEMORY_PRESSURE };

		expect(nextTurn(jobs, pressed, NOW)).toBeUndefined();
		expect(waitReasons(jobs, pressed, NOW).get("quick")).toBe("memory");
	});

	// 10 November: 30 sent changed-checks runs from 14:00 peaked at 0.4 GB
	// at most yet waited 14,016 s on memory (80ECO2, 5FWIUS).
	it("gives a sent changed-checks its turn while memory is pressed, when its booking fits", () => {
		const sent = older("sent", 9_000, {
			what: "direnv exec . changed-checks",
			needsGib: 6,
			sent: true,
		});
		const pressed = { ...ROOMY, memoryPressure: MOST_MEMORY_PRESSURE };

		expect(nextTurn([sent], pressed, NOW)?.id).toBe("sent");
		expect(waitReasons([sent], pressed, NOW).get("sent")).toBe("order");
		const tight = { ...pressed, availableGib: 2 };
		expect(nextTurn([sent], tight, NOW)).toBeUndefined();
		expect(waitReasons([sent], tight, NOW).get("sent")).toBe("memory");
	});

	it("holds a sent nix-offload there that may build here while idle, while memory is pressed", () => {
		const idle = older("idle", 9_000, {
			what: "nix-offload there --here-when-idle . checks.x86_64-linux.x",
			needsGib: 6,
			sent: true,
		});
		const pressed = { ...ROOMY, memoryPressure: MOST_MEMORY_PRESSURE };

		expect(nextTurn([idle], pressed, NOW)).toBeUndefined();
		expect(waitReasons([idle], pressed, NOW).get("idle")).toBe("memory");
	});

	it("says vms when the VMs allowed at once are running", () => {
		const running = Array.from({ length: MOST_VMS }, (_, at) =>
			job(`vm${at}`, { kind: "vm-test", started: long }),
		);
		const jobs = [...running, older("vm", 9_000, { kind: "vm-test" })];
		expect(waitReasons(jobs, ROOMY, NOW).get("vm")).toBe("vms");
	});

	it("starts no VM here while the person's programs wait on memory, even the first", () => {
		// 13:53 on 29 October: app.slice stalled 5%, and VMs below the count
		// kept starting, so nothing waited and no builder was lent.
		const jobs = [older("vm", 9_000, { kind: "vm-test" })];
		const calm = { ...ROOMY, floorsPressure: 0 };
		const waiting = { ...ROOMY, floorsPressure: MOST_FLOORS_PRESSURE + 0.5 };

		expect(nextTurn(jobs, calm, NOW)?.id).toBe("vm");
		expect(nextTurn(jobs, waiting, NOW)).toBeUndefined();
		expect(waitReasons(jobs, waiting, NOW).get("vm")).toBe("vms");
		expect(roomLeft([], waiting, NOW).vms).toBe(0);
		// Where no floor is read there is nobody's memory to guard.
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("vm");
	});

	it("starts no VM here while CPU pressure is past its line, and a build a builder takes still goes", () => {
		const vm = older("vm", 9_000, { kind: "vm-test" });
		const lent = { ...BUSY, offload: { builds: 1, vms: 0 } };
		expect(nextTurn([vm], lent, NOW)).toBeUndefined();
		expect(waitReasons([vm], lent, NOW).get("vm")).toBe("vms");
		expect(nextTurn([vm, older("build", 8_000)], lent, NOW)?.id).toBe("build");
	});

	it("lets a queue-first quest's short job past the CPU and IO hold, and no other", () => {
		// 8 November: a deploy lane's 13-second cargo test waited 1,524 s,
		// 671 of them held here (L3V9AA, with 5FWIUS's rule).
		const lane = (id: string, lastRanS: number) =>
			older(id, 9_000, {
				what: "cargo test --lib wipe",
				quest: "QEST-DEPLOY",
				lastRanS,
			});
		const first = new Set(["QEST-DEPLOY"]);
		const stuck = { ...ROOMY, ioPressure: MOST_IO_PRESSURE_FOR_BUILDS + 10 };
		expect(
			nextTurn([lane("short", 13)], stuck, NOW, RULES, NOBODY, first)?.id,
		).toBe("short");
		expect(
			nextTurn([lane("long", 600)], stuck, NOW, RULES, NOBODY, first),
		).toBeUndefined();
		expect(nextTurn([lane("other", 13)], stuck, NOW)).toBeUndefined();
		// Joel's own programs waiting still hold it.
		const felt = { ...stuck, floorsCpuPressure: MOST_FLOORS_CPU_PRESSURE + 1 };
		expect(
			nextTurn([lane("short", 13)], felt, NOW, RULES, NOBODY, first),
		).toBeUndefined();
	});

	it("holds builds that run here while the machine is past its CPU line", () => {
		// 21:09 on 7 November: cargo, clippy and vitest from several
		// sessions all started with the machine at load 66 (80ECO2).
		const cargo = older("cargo", 9_000, { what: "cargo clippy" });
		const nix = older("nix", 8_000);
		const lent = { ...BUSY, offload: { builds: 1, vms: 0 } };
		expect(nextTurn([cargo], BUSY, NOW)).toBeUndefined();
		expect(waitReasons([cargo], BUSY, NOW).get("cargo")).toBe("busy");
		expect(nextTurn([cargo, nix], lent, NOW)?.id).toBe("nix");
		const under = { ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_FOR_BUILDS - 1 };
		expect(nextTurn([cargo], under, NOW)?.id).toBe("cargo");
		const quick = older("quick", 9_000, { what: "cargo test", quick: true });
		expect(nextTurn([quick], BUSY, NOW)?.id).toBe("quick");
		// 00:12 on 8 November: a changed-checks sent whole to a builder
		// waited 46 minutes here, evaluating nothing here (5FWIUS).
		const sent = older("sent", 9_000, { what: "changed-checks", sent: true });
		expect(nextTurn([sent], BUSY, NOW)?.id).toBe("sent");
		// 01:20 on 8 November: avg10 dipped and a held cargo test started
		// at 79.9%; the minute's figure holds it through a dip.
		const dipped = { ...ROOMY, cpuPressure: 60, cpuPressureMinute: 75 };
		expect(nextTurn([cargo], dipped, NOW)).toBeUndefined();
		// 01:30: 48 links in D state at IO pressure 96% (P9R1KI).
		const stuck = { ...ROOMY, ioPressure: MOST_IO_PRESSURE_FOR_BUILDS };
		expect(waitReasons([cargo], stuck, NOW).get("cargo")).toBe("busy");
		// Busy but under the line, a build goes capped, cargo's jobs with it.
		const warm = { ...ROOMY, cpuPressure: CAPS_BUILDS_FROM_CPU_PRESSURE };
		expect(nextTurn([cargo], warm, NOW)).toEqual({ ...cargo, capped: true });
		expect(nextTurn([cargo], ROOMY, NOW)).toEqual(cargo);
		// While the person's own programs wait, even it waits.
		const felt = { ...ROOMY, floorsCpuPressure: MOST_FLOORS_CPU_PRESSURE + 1 };
		expect(nextTurn([sent], felt, NOW)).toBeUndefined();
	});

	it("starts nothing while the person's own programs wait on CPU", () => {
		// 21:27 on 7 November: the machine read 63% while app.slice read
		// 0.3%, so only what the person feels holds everything.
		const jobs = [older("vm", 9_000, { kind: "vm-test" }), older("b", 8_000)];
		const felt = {
			...ROOMY,
			floorsCpuPressure: MOST_FLOORS_CPU_PRESSURE + 1,
		};
		expect(nextTurn(jobs, felt, NOW)).toBeUndefined();
		expect(Object.fromEntries(waitReasons(jobs, felt, NOW))).toEqual({
			vm: "busy",
			b: "busy",
		});
		expect(roomLeft(jobs, felt, NOW)).toEqual({ vms: 0, builds: 0 });
		expect(
			waitsWithRoom(jobs, felt),
			"a wait the person's own programs cause is not wasted",
		).toBe(false);
		const calm = { ...ROOMY, cpuPressure: 63, floorsCpuPressure: 0.3 };
		expect(nextTurn(jobs, calm, NOW)?.id).toBe("vm");
	});

	it("gives a VM check held here a builder's VM slot", () => {
		const vm = older("vm", 9_000, { kind: "vm-check" });
		const stalled = { ...ROOMY, floorsPressure: MOST_FLOORS_PRESSURE + 4 };
		const lent = { ...stalled, offload: { builds: 32, vms: 32 } };
		expect(nextTurn([vm], stalled, NOW)).toBeUndefined();
		expect(nextTurn([vm], lent, NOW)?.id).toBe("vm");
	});

	it("says behind when builds beside a VM check are at their limit", () => {
		const jobs = [
			job("check", { kind: "vm-check", started: long }),
			job("beside", { started: long, capped: true }),
			older("build", 9_000),
			older("after", 8_000),
		];
		expect(nextTurn(jobs, ROOMY, NOW)).toBeUndefined();
		expect(Object.fromEntries(waitReasons(jobs, ROOMY, NOW))).toEqual({
			build: "behind",
			after: "order",
		});
	});

	it("puts a deploy's stamp first, with only the capped build beside it", () => {
		const build = older("build", 9_000);
		const stamp = older("stamp", 8_000, { kind: "stamp" });
		expect(nextTurn([build, stamp], ROOMY, NOW)?.id).toBe("stamp");

		const stamping = job("stamping", { kind: "stamp", started: long });
		expect(nextTurn([stamping, build], ROOMY, NOW)).toEqual({
			...build,
			capped: true,
		});
		const beside = job("beside", { started: long, capped: true });
		expect(nextTurn([stamping, beside, build], ROOMY, NOW)).toBeUndefined();
		expect(
			waitReasons([stamping, beside, build], ROOMY, NOW).get("build"),
		).toBe("behind");
	});

	it("says order for the job given the next turn and those after it", () => {
		const jobs = [older("a", 9_000), older("b", 8_000)];
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("a");
		expect(Object.fromEntries(waitReasons(jobs, ROOMY, NOW))).toEqual({
			a: "order",
			b: "order",
		});
	});
});

describe("the room left", () => {
	it("counts what would start now, past what runs and waits", () => {
		expect(roomLeft([], ROOMY, NOW)).toEqual({ vms: MOST_VMS, builds: 10 });
		// A VM just started leaves no VM room until it settles.
		const running = job("vm", { kind: "vm-test", started: startedAgo(1) });
		expect(roomLeft([running, job("next")], ROOMY, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
		const settled = { ...running, started: startedAgo(VM_SPREAD_MS) };
		expect(roomLeft([settled, job("next")], ROOMY, NOW)).toEqual({
			vms: MOST_VMS - 1,
			builds: 0,
		});
		expect(roomLeft([], { ...ROOMY, availableGib: 9, vms: 1 }, NOW)).toEqual({
			vms: 1,
			builds: 1,
		});
		const queued = [job("vm", { kind: "vm-test" })];
		expect(roomLeft(queued, { ...ROOMY, availableGib: 10 }, NOW)).toEqual({
			vms: 0,
			builds: 1,
		});
		expect(roomLeft([], { ...ROOMY, memoryPressure: 10 }, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
	});

	it("leaves no VM check past a build held for one", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		// Its qemu runs here, as the machine's count shows.
		const here = { ...ROOMY, vms: 1 };
		expect(roomLeft([check], here, NOW)).toEqual({
			vms: MOST_VMS - 1,
			builds: 1,
		});
		// Past the CPU line no build starts beside it, and no VM here either.
		expect(roomLeft([check], BUSY, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
		expect(roomLeft([check, job("build")], BUSY, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
	});

	it("says the room in words, or nothing", () => {
		expect(roomSaid({ vms: 2, builds: 8 })).toBe(
			"2 more VM tests and 8 more builds",
		);
		expect(roomSaid({ vms: 1, builds: 0 })).toBe("1 more VM test");
		expect(roomSaid({ vms: 0, builds: 0 })).toBe("");
	});
});
