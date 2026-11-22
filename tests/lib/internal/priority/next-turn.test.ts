import { describe, expect, it } from "vitest";
import { NOBODY } from "../../../../lib/internal/priority/awaited.ts";
import {
	CHANGED_CHECKS_GIB,
	EVAL_TESTS_GIB,
	EVALUATION_GIB,
	EVERY_CHECK_GIB,
	FIRST_MOST_MEMORY_FULL,
	type Job,
	KEEPS_LINE_FOR_MS,
	kindOf,
	LENDING_WAIT_MS,
	leastGibOfCommand,
	MOST_FLOORS_PRESSURE,
	MOST_VMS,
	needsGibOf,
	needsGibOfCommand,
	nextTurn,
	PASS_AFTER_MS,
	QUICK_OUTRUN_MS,
	RAMP_MS,
	SPREAD_MS,
	VM_SETTLE_MS,
	VM_SPREAD_MS,
	VM_STEADY_MS,
	waitingInOrder,
	waitReasons,
	waitsWithRoom,
	whatOf,
} from "../../../../lib/internal/priority/queue.ts";
import { BUSY, job, NOW, ROOMY, startedAgo } from "./queue-line.ts";

describe("whose turn it is", () => {
	it("starts timed work first, then the oldest", () => {
		const jobs = [
			job("old"),
			job("newer", { since: startedAgo(10_000) }),
			job("timed", { kind: "benchmark", since: startedAgo(5_000) }),
		];
		expect(waitingInOrder(jobs).map((one) => one.id)).toEqual([
			"timed",
			"old",
			"newer",
		]);
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("timed");
	});

	it("starts the work a session waits on first within its class", () => {
		const awaited = new Set(["held-on"]);
		const jobs = [
			job("old"),
			job("waited", {
				since: startedAgo(10_000),
				owner: { session: "held-on", pid: 2 },
			}),
			job("timed", { kind: "benchmark", since: startedAgo(5_000) }),
		];
		expect(waitingInOrder(jobs, awaited).map((one) => one.id)).toEqual([
			"timed",
			"waited",
			"old",
		]);
		const bulk = jobs.filter((one) => one.id !== "timed");
		expect(nextTurn(bulk, ROOMY, NOW, undefined, awaited)?.id).toBe("waited");
		expect(nextTurn(bulk, ROOMY, NOW)?.id).toBe("old");
	});

	it("starts a quest put first after the work a session waits on", () => {
		const old = job("old", { since: startedAgo(600_000) });
		const lab = job("lab", { quest: "QEST-LAB" });
		const parked = job("parked", {
			owner: { session: "waited-on", pid: 2 },
			since: startedAgo(1),
		});
		const bench = job("bench", { kind: "benchmark", since: startedAgo(1) });
		const first = new Set(["QEST-LAB"]);

		expect(
			waitingInOrder(
				[old, lab, parked, bench],
				new Set(["waited-on"]),
				first,
			).map((one) => one.id),
		).toEqual(["bench", "parked", "lab", "old"]);
		expect(nextTurn([old, lab], ROOMY, NOW, undefined, NOBODY, first)?.id).toBe(
			"lab",
		);
		expect(nextTurn([old, lab], ROOMY, NOW)?.id).toBe("old");
	});

	it("gives no turn within a spread of the last, nor under pressure", () => {
		const running = job("running", { started: startedAgo(SPREAD_MS - 1) });
		expect(nextTurn([running, job("next")], ROOMY, NOW)).toBeUndefined();
		const settled = { ...running, started: startedAgo(SPREAD_MS) };
		expect(nextTurn([settled, job("next")], ROOMY, NOW)?.id).toBe("next");
		expect(
			nextTurn([job("next")], { ...ROOMY, memoryPressure: 10 }, NOW),
		).toBeUndefined();
	});

	describe("a quest put first while memory is short", () => {
		// 22 November, 04:13: memory pressure at 13.3% held 29 of 30 waiting
		// jobs on memory, the capacity path's among them.
		const first = new Set(["QEST-CAP"]);
		const short = (memoryFullMinute: number | undefined) => ({
			...ROOMY,
			memoryPressure: 13,
			memoryFullMinute,
		});
		const cap = job("cap", { quest: "QEST-CAP" });
		const other = job("other", { since: startedAgo(600_000) });
		const turn = (jobs: Job[], room: ReturnType<typeof short>) =>
			nextTurn(jobs, room, NOW, undefined, NOBODY, first)?.id;

		it("starts one up to the most of the minute stalled", () => {
			expect(turn([other, cap], short(18))).toBe("cap");
			expect(turn([other, cap], short(FIRST_MOST_MEMORY_FULL))).toBe("cap");
		});

		it("starts none past it, nor where the minute isn't read", () => {
			expect(turn([other, cap], short(FIRST_MOST_MEMORY_FULL + 1))).toBe(
				undefined,
			);
			expect(turn([other, cap], short(undefined))).toBe(undefined);
		});

		it("starts no second while one of a first quest runs", () => {
			const running = job("running", {
				quest: "QEST-CAP",
				started: startedAgo(SPREAD_MS + 60_000),
			});
			expect(turn([running, cap], short(18))).toBe(undefined);
		});

		it("lets nobody else's start", () => {
			expect(turn([other], short(18))).toBe(undefined);
		});

		it("isn't held behind a job memory holds at the head", () => {
			const vm = job("vm", { kind: "vm-test", since: startedAgo(900_000) });
			const bench = job("bench", {
				kind: "benchmark",
				since: startedAgo(900_000),
			});
			expect(turn([vm, bench, other, cap], short(18))).toBe("cap");
			expect(
				Object.fromEntries(
					waitReasons(
						[vm, bench, other, cap],
						short(18),
						NOW,
						undefined,
						NOBODY,
						first,
					),
				),
			).toEqual({
				vm: "memory",
				bench: "memory",
				other: "memory",
				cap: "order",
			});
		});

		it("says it waits on memory when the minute holds it too", () => {
			expect(
				Object.fromEntries(
					waitReasons([cap], short(30), NOW, undefined, NOBODY, first),
				),
			).toEqual({ cap: "memory" });
		});
	});

	it("holds everyone behind a job the memory left can't fit", () => {
		const jobs = [job("vm", { kind: "vm-test" }), job("small")];
		expect(nextTurn(jobs, { ...ROOMY, availableGib: 5 }, NOW)).toBeUndefined();
		expect(nextTurn(jobs, { ...ROOMY, availableGib: 6 }, NOW)?.id).toBe("vm");
	});

	describe("a job memory can't free", () => {
		// 11-03: a 24 GiB evaluation of every check waited 4,473 s on memory
		// with nothing queued running from 20:05Z, and everything behind it
		// waited on the order.
		const stuck = (memoryMs: number, over: Partial<Job> = {}) =>
			job("every", {
				what: "nix eval --json .#checks.x86_64-linux --apply f",
				since: startedAgo(memoryMs + 60_000),
				waitingSince: { reason: "memory", at: startedAgo(memoryMs) },
				...over,
			});
		const small = job("small");
		const short = { ...ROOMY, availableGib: 10 };

		it("lets a job that fits pass one that waited on memory past the wait", () => {
			const jobs = [stuck(PASS_AFTER_MS + 1_000), small];
			expect(nextTurn(jobs, short, NOW)?.id).toBe("small");
			expect(Object.fromEntries(waitReasons(jobs, short, NOW))).toEqual({
				every: "memory",
				small: "order",
			});
		});

		it("counts the memory it waited on before as well as now", () => {
			const half = PASS_AFTER_MS / 2 + 1_000;
			const jobs = [
				stuck(half, { waitedOnMs: { memory: half, order: 60_000 } }),
				small,
			];
			expect(nextTurn(jobs, short, NOW)?.id).toBe("small");
		});

		it("lets pass only a job that fits now", () => {
			const jobs = [stuck(PASS_AFTER_MS + 1_000), job("mid", { needsGib: 12 })];
			expect(nextTurn(jobs, short, NOW)).toBeUndefined();
			expect(waitReasons(jobs, short, NOW).get("mid")).toBe("memory");
		});

		it("holds the line for a job the running jobs will free room for", () => {
			const running = job("running", {
				needsGib: 16,
				started: startedAgo(RAMP_MS + 1_000),
			});
			const jobs = [running, stuck(PASS_AFTER_MS + 1_000), small];
			expect(nextTurn(jobs, short, NOW)).toBeUndefined();
			expect(Object.fromEntries(waitReasons(jobs, short, NOW))).toEqual({
				every: "memory",
				small: "order",
			});
		});

		it("holds the line for a job that has waited on memory under the wait", () => {
			const jobs = [stuck(PASS_AFTER_MS - 1_000), small];
			expect(nextTurn(jobs, short, NOW)).toBeUndefined();
			expect(waitReasons(jobs, short, NOW).get("small")).toBe("order");
		});

		it("starts the job it passed as soon as that one fits", () => {
			const jobs = [stuck(PASS_AFTER_MS + 1_000), small];
			const room = { ...ROOMY, availableGib: EVERY_CHECK_GIB };
			expect(nextTurn(jobs, room, NOW)?.id).toBe("every");
			expect(waitReasons(jobs, room, NOW).get("every")).toBe("order");
		});

		describe("while a long run holds the memory it waits for", () => {
			// 11-03: a 20 GiB flake check and a 24 GiB evaluation waited on the
			// memory a changed-checks --build held, 13 GiB for its 6,402 s, and
			// 30 tests of 1 to 171 s that fit waited behind them on the order.
			const check = (endsInMs: number) =>
				job("check", {
					kind: "vm-check",
					what: "changed-checks --build",
					needsGib: 13,
					lastRanS: 6_400,
					started: startedAgo(6_400_000 - endsInMs),
				});
			const flake = stuck(PASS_AFTER_MS + 1_000, { needsGib: 20 });
			const room = { ...ROOMY, availableGib: 9 };

			it("lets work that fits pass, when how long it runs is unknown", () => {
				const jobs = [check(KEEPS_LINE_FOR_MS * 10), flake, small];
				expect(nextTurn(jobs, room, NOW)?.id).toBe("small");
				expect(Object.fromEntries(waitReasons(jobs, room, NOW))).toEqual({
					every: "memory",
					small: "order",
				});
			});

			it("holds work that would still run when that memory comes back", () => {
				const long = job("long", { lastRanS: 7_200 });
				const short = job("short", {
					since: startedAgo(30_000),
					lastRanS: 30,
				});
				const jobs = [check(KEEPS_LINE_FOR_MS * 10), flake, long, short];
				expect(nextTurn(jobs, room, NOW)?.id).toBe("short");
				expect(waitReasons(jobs, room, NOW).get("long")).toBe("order");
			});

			it("holds the line once that memory is due back within the wait", () => {
				const jobs = [check(KEEPS_LINE_FOR_MS - 1_000), flake, small];
				expect(nextTurn(jobs, room, NOW)).toBeUndefined();
				expect(waitReasons(jobs, room, NOW).get("small")).toBe("order");
			});

			it("counts a run past the length its last one took as due as long again", () => {
				// mw192vak's last run took 1,010 s; it ran 6,402.
				const outran = { ...check(-60_000), lastRanS: 1_010 };
				expect(nextTurn([outran, flake, small], room, NOW)?.id).toBe("small");
				const young = job("young", {
					needsGib: 13,
					started: startedAgo(KEEPS_LINE_FOR_MS / 2),
				});
				expect(nextTurn([young, flake, small], room, NOW)).toBeUndefined();
			});

			it("holds the line again once work that passed it would free its room", () => {
				const passed = job("passed", {
					needsGib: 4,
					started: startedAgo(RAMP_MS + 1_000),
				});
				const jobs = [check(KEEPS_LINE_FOR_MS * 10), passed, flake, small];
				const left = { ...room, availableGib: 16 };
				expect(nextTurn(jobs, left, NOW)).toBeUndefined();
				expect(waitReasons(jobs, left, NOW).get("small")).toBe("order");
			});
		});
	});

	it("holds an evaluation of every check that reads only their names to a build's", () => {
		// mw13l2lv waited 4,473 s for 24 GiB on 3 November; listing core's
		// 678 names held 169 MB at most (16V6F4).
		const named = [
			`nix eval --json .#checks.x86_64-linux --apply 'c: builtins.filter (n: builtins.match "vm-(screens|greeter|boot).*" n != null) (builtins.attrNames c)'`,
			`nix eval --json "path:$PWD#checks" --apply 'builtins.mapAttrs (s: c: builtins.attrNames c)' 2>/dev/null`,
			`nix eval --json "$f#checks.x86_64-linux" --apply builtins.attrNames | jq -M -r '.[]'`,
			`nix eval --json "path:$t#checks" --apply 'c: builtins.mapAttrs (_: builtins.attrNames) c'`,
			`nix eval --json .#checks --apply 'c: builtins.mapAttrs (s: v: builtins.attrNames v) c'`,
			`nix eval --json .#checks.x86_64-linux --apply 'a: builtins.filter (n: n != "penelope") (builtins.attrNames a)'`,
		];
		for (const command of named) {
			expect(needsGibOfCommand("build", command)).toBe(4);
		}
		const forced = [
			"nix eval --json .#checks.x86_64-linux",
			`nix eval --json .#checks.x86_64-linux --apply 'c: map (n: c.\${n}.drvPath) (builtins.attrNames c)'`,
			`nix eval --json .#checks --apply 'builtins.mapAttrs (s: c: builtins.mapAttrs (n: v: v.drvPath) c)'`,
			`nix eval --json .#checks.x86_64-linux --apply 'c: builtins.attrValues c'`,
			// Each returns a set of checks beside their names, which --json forces.
			`nix eval --json .#checks.x86_64-linux --apply 'c: [ (builtins.attrNames c) c ]'`,
			`nix eval --json .#checks --apply 'builtins.mapAttrs (s: c: [ (builtins.attrNames c) c ])'`,
			`nix eval --json .#checks --apply 'c: builtins.mapAttrs (s: v: v) c'`,
			`nix eval --json .#checks --apply 'c: builtins.mapAttrs (_: (x: [ (builtins.attrNames x) x ])) c'`,
			`nix eval --json .#checks.x86_64-linux --apply 'c: map (n: c) (builtins.attrNames c)'`,
			// Cut short, so what it applies can't be read.
			`nix eval --raw '.#checks.x86_64-linux' --apply 'c: b...`,
		];
		for (const command of forced) {
			expect(needsGibOfCommand("build", command)).toBe(EVERY_CHECK_GIB);
		}
	});

	it("holds a zone's evaluation tests to what nix-unit held when it was killed, at least", () => {
		const tec =
			"~/.local/state/tec/toolchain/base_profile/bin/tec run //system/aquifer/converge:evalTests";
		expect(kindOf(tec)).toBe("build");
		expect(kindOf("nix-unit --flake .#tests")).toBe("build");
		expect(needsGibOfCommand("build", tec)).toBe(EVAL_TESTS_GIB);
		// The chain T9C192 ran: its first step is a cargo build's.
		const chain = `cd converge && { (set -e; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test; ${tec}); echo done; }`;
		expect(needsGibOfCommand("build", chain)).toBe(EVAL_TESTS_GIB);
		expect(leastGibOfCommand(chain)).toBe(EVAL_TESTS_GIB);
		expect(whatOf(chain).slice(0, tec.length)).toBe(tec);
		// Named, not run, or another target: no floor.
		expect(leastGibOfCommand(`echo "then ${tec}"`)).toBe(0);
		expect(leastGibOfCommand("tec run //system/aquifer/converge:test")).toBe(0);
		expect(leastGibOfCommand("ls /nix/store/x-nix-unit-2.0")).toBe(0);
	});

	it("holds a whole flake's check to what its evaluation keeps", () => {
		const check = job("check", { what: "nix flake check --keep-going -L" });
		expect(needsGibOf(check)).toBe(EVALUATION_GIB);
		const one = job("one", { what: "nix build .#checks.x.foo" });
		expect(needsGibOf(one)).toBe(4);
		expect(
			needsGibOf(job("wrapped", { what: "nice -n 10 nix -L flake check" })),
		).toBe(EVALUATION_GIB);
		// Evaluating every check's derivation at once reached 24 GB as a
		// bare `nix eval`; changed-checks evaluates them 40 at a time.
		expect(
			needsGibOf(
				job("every", {
					what: "nix eval --json .#checks.x86_64-linux --apply f",
				}),
			),
		).toBe(EVERY_CHECK_GIB);
		expect(
			needsGibOf(job("changed", { what: "changed-checks --build --no-vm" })),
		).toBe(CHANGED_CHECKS_GIB);
		expect(
			needsGibOf(
				job("vm", { kind: "vm-check", what: "changed-checks --build" }),
			),
		).toBe(CHANGED_CHECKS_GIB);
		expect(CHANGED_CHECKS_GIB).toBeLessThan(EVERY_CHECK_GIB);
		const room = { ...ROOMY, availableGib: EVALUATION_GIB - 1 };
		expect(nextTurn([check], room, NOW)).toBeUndefined();
		expect(nextTurn([job("build")], room, NOW)?.id).toBe("build");
	});

	it("counts what just started as taken while it grows", () => {
		const growing = job("growing", { started: startedAgo(RAMP_MS - 1) });
		const room = { ...ROOMY, availableGib: 7 };
		expect(nextTurn([growing, job("next")], room, NOW)).toBeUndefined();
		const grown = { ...growing, started: startedAgo(RAMP_MS) };
		expect(nextTurn([grown, job("next")], room, NOW)?.id).toBe("next");
	});

	it("lets the next job past a VM the VMs at once hold back", () => {
		const vms = Array.from({ length: MOST_VMS }, (_, at) =>
			job(`vm${at}`, { kind: "vm-test", started: startedAgo(RAMP_MS) }),
		);
		const jobs = [...vms, job("third", { kind: "vm-test" }), job("build")];
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("build");
	});

	it("counts the VMs the machine runs, queued or not", () => {
		const machine = { ...ROOMY, vms: MOST_VMS };
		expect(
			nextTurn([job("vm", { kind: "vm-test" })], machine, NOW),
		).toBeUndefined();
		// A VM outside the queue is a check the daemon runs: builds beside
		// it are capped.
		expect(nextTurn([job("build")], { ...ROOMY, vms: 1 }, NOW)).toMatchObject({
			capped: true,
		});
		const test = job("test", { kind: "vm-test", started: startedAgo(RAMP_MS) });
		expect(nextTurn([test, job("build")], { ...ROOMY, vms: 1 }, NOW)).toEqual(
			job("build"),
		);
	});

	it("starts a build beside a VM check on a busy machine, but not while the person's programs stall on memory", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const night = { ...ROOMY, cpuPressure: 68, floorsPressure: 0 };
		expect(nextTurn([check, job("build")], night, NOW)).toEqual({
			...job("build"),
			capped: true,
		});
		const stalled = { ...night, floorsPressure: MOST_FLOORS_PRESSURE + 0.5 };
		expect(nextTurn([check, job("build")], stalled, NOW)).toBeUndefined();
		expect(nextTurn([job("build")], stalled, NOW)?.id).toBe("build");
	});

	it("holds the checks behind a build that waits for a check", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const later = job("later", { kind: "vm-check", since: startedAgo(1) });
		expect(nextTurn([check, job("build"), later], BUSY, NOW)).toBeUndefined();
	});

	it("starts one capped build beside a VM check while the CPU is free", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		expect(nextTurn([check, job("build")], ROOMY, NOW)).toEqual({
			...job("build"),
			capped: true,
		});
		const beside = job("beside", { started: startedAgo(RAMP_MS) });
		expect(nextTurn([check, beside, job("build")], ROOMY, NOW)).toBeUndefined();
		expect(nextTurn([check, job("build")], BUSY, NOW)).toBeUndefined();
		const older = job("older", { cappable: undefined });
		expect(nextTurn([check, older], ROOMY, NOW)).toBeUndefined();
		expect(nextTurn([older], ROOMY, NOW)?.id).toBe("older");
		const waiting = [job("build"), job("bench", { kind: "benchmark" })];
		// Past the CPU line a benchmark waits too, as builds do.
		expect(nextTurn([check, ...waiting], BUSY, NOW)).toBeUndefined();
		expect(
			nextTurn([check, job("build")], ROOMY, NOW, {
				buildsWaitForVmChecks: false,
			})?.id,
		).toBe("build");
		const building = job("building", { started: startedAgo(RAMP_MS) });
		expect(
			nextTurn([building, job("check", { kind: "vm-check" })], ROOMY, NOW)?.id,
		).toBe("check");
	});

	it("starts quick work ahead of other bulk, past a job held back, one at a time", () => {
		const quick = job("quick", { quick: true, since: startedAgo(1) });
		expect(nextTurn([job("build"), quick], ROOMY, NOW)?.id).toBe("quick");
		const big = job("big", { what: "changed-checks --build --no-vm" });
		const room = { ...ROOMY, availableGib: 10 };
		expect(nextTurn([big, job("build")], room, NOW)).toBeUndefined();
		expect(nextTurn([big, quick], room, NOW)?.id).toBe("quick");
		const another = { ...quick, id: "another", started: startedAgo(RAMP_MS) };
		expect(nextTurn([another, big, quick], room, NOW)).toBeUndefined();
		expect(nextTurn([another, quick], room, NOW)?.id).toBe("quick");
	});

	it("gives quick work a turn of its own beside a VM check, whatever the CPU", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const quick = job("quick", { quick: true });
		expect(nextTurn([check, job("build"), quick], BUSY, NOW)).toEqual({
			...quick,
			capped: true,
		});
		const beside = job("beside", { started: startedAgo(RAMP_MS) });
		expect(nextTurn([check, beside, quick], ROOMY, NOW)?.id).toBe("quick");
		const running = { ...quick, id: "running", started: startedAgo(RAMP_MS) };
		expect(nextTurn([check, running, quick], ROOMY, NOW)?.id).toBe(undefined);
		expect(nextTurn([check, running, job("build")], ROOMY, NOW)?.id).toBe(
			"build",
		);
	});

	it("lets quick work past a job marked quick that has run past quick work's time, which counts as a build", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		// Learned as quick from a cached run, it is rebuilding for real.
		const outrun = job("kernel", {
			quick: true,
			started: startedAgo(QUICK_OUTRUN_MS),
		});
		const quick = job("quick", { quick: true });

		expect(nextTurn([check, outrun, quick], ROOMY, NOW)?.id).toBe("quick");
		expect(
			nextTurn([check, outrun, job("build")], ROOMY, NOW),
			"it holds the one build beside a VM check",
		).toBeUndefined();
	});

	it("counts a wait as wasted only when its memory stands free", () => {
		const vm = job("vm", { kind: "vm-test" });
		const waiting = [vm];
		expect(
			waitsWithRoom(waiting, ROOMY),
			"a VM test waiting with its memory free is a wasted wait",
		).toBe(true);
		expect(
			waitsWithRoom(waiting, { ...ROOMY, availableGib: 5 }),
			"a VM test waiting for memory is no wasted wait",
		).toBe(false);
		expect(
			waitsWithRoom([{ ...vm, started: startedAgo(1) }], ROOMY),
			"a VM test already started is not waiting",
		).toBe(false);
	});
});

describe("a builder elsewhere", () => {
	const long = startedAgo(60 * 60 * 1000);
	const vmsRunning = Array.from({ length: MOST_VMS }, (_, i) =>
		job(`vm-${i}`, { kind: "vm-check", started: long }),
	);
	const full = { ...ROOMY, vms: MOST_VMS };
	const withVms = { builds: 4, vms: 2 };

	it("gives a waiting VM check a builder's free VM slot, and none once they're spoken for", () => {
		const waiting = job("vm-next", { kind: "vm-check" });
		expect(nextTurn([...vmsRunning, waiting], full, NOW)).toBeUndefined();
		expect(
			waitReasons([...vmsRunning, waiting], full, NOW).get("vm-next"),
		).toBe("vms");

		const standing = { ...full, offload: withVms };
		expect(nextTurn([...vmsRunning, waiting], standing, NOW)?.id).toBe(
			"vm-next",
		);

		// Two given their turns this minute are still evaluating, so they
		// hold no slot's lock yet, but the two free slots are theirs.
		const evaluating = [
			...vmsRunning,
			job("vm-there-1", { kind: "vm-check", started: startedAgo(20_000) }),
			job("vm-there-2", { kind: "vm-check", started: startedAgo(10_000) }),
			waiting,
		];
		expect(nextTurn(evaluating, standing, NOW)).toBeUndefined();
	});

	it("holds slow builds for a builder being lent, a few minutes at most, and lets the rest go", () => {
		// A nix build started while the builder boots keeps a hook that
		// found none, and runs wholly here (15:48 on 29 October).
		const lending = { ...ROOMY, lendingSince: NOW - 30_000 };
		const build = job("build");
		expect(nextTurn([build], lending, NOW)).toBeUndefined();
		expect(waitReasons([build], lending, NOW).get("build")).toBe("lending");

		// The builder takes no VM work, and quick builds stay here.
		const check = job("check", { kind: "vm-check" });
		const quick = job("quick", { quick: true });
		const test = job("test", { kind: "vm-test" });
		expect(nextTurn([build, check], lending, NOW)?.id).toBe("check");
		expect(nextTurn([build, quick], lending, NOW)?.id).toBe("quick");
		expect(nextTurn([build, test], lending, NOW)?.id).toBe("test");

		const late = { ...ROOMY, lendingSince: NOW - LENDING_WAIT_MS };
		expect(nextTurn([build], late, NOW)?.id).toBe("build");
	});

	it("starts VMs one at a time here, each once the last has settled", () => {
		// 16:28 to 16:31 on 29 October: four VMs in before any one's memory
		// showed, and six ran at a 17.6% stall.
		const next = job("next", { kind: "vm-check" });
		const just = job("just", { kind: "vm-test", started: startedAgo(30_000) });
		expect(nextTurn([just, next], ROOMY, NOW)).toBeUndefined();
		expect(waitReasons([just, next], ROOMY, NOW).get("next")).toBe("vms");

		const minute = startedAgo(VM_SPREAD_MS + 1_000);
		const growing = { ...just, started: minute, grewAt: startedAgo(5_000) };
		expect(nextTurn([growing, next], ROOMY, NOW)).toBeUndefined();

		const steady = { ...growing, grewAt: startedAgo(VM_STEADY_MS) };
		expect(nextTurn([steady, next], ROOMY, NOW)?.id).toBe("next");

		// A long test still growing past its first minutes holds nobody.
		const old = { ...growing, started: startedAgo(VM_SETTLE_MS) };
		expect(nextTurn([old, next], ROOMY, NOW)?.id).toBe("next");
		// Builds aren't paced.
		expect(nextTurn([just, job("build")], ROOMY, NOW)?.id).toBe("build");
	});

	it("counts a full builder as no room, since Nix then builds here", () => {
		// 14:27 on 29 October: the lent builder's eight slots all building,
		// and VM checks counted against them ran their qemu here.
		const waiting = job("vm-next", { kind: "vm-check" });
		const busy = { ...full, offload: { builds: 0, vms: 0 } };
		expect(nextTurn([...vmsRunning, waiting], busy, NOW)).toBeUndefined();
	});

	it("gives a VM test none of a builder's slots, since its qemu runs here", () => {
		const test = job("vm-next", { kind: "vm-test" });
		const lent = { ...full, offload: { builds: 8, vms: 8 } };
		expect(nextTurn([...vmsRunning, test], lent, NOW)).toBeUndefined();
		expect(waitReasons([...vmsRunning, test], lent, NOW).get("vm-next")).toBe(
			"vms",
		);
	});

	it("counts no VM slots for a builder that can't run VMs", () => {
		const waiting = job("vm-next", { kind: "vm-check" });
		const buildsOnly = { ...full, offload: { builds: 8, vms: 0 } };
		expect(nextTurn([...vmsRunning, waiting], buildsOnly, NOW)).toBeUndefined();
	});

	it("starts builds beside a VM check on its slots whatever this machine's CPU pressure", () => {
		const checking = [job("vm", { kind: "vm-check", started: long })];
		const pressed = { ...BUSY, vms: 1 };
		const build = job("build");
		expect(nextTurn([...checking, build], pressed, NOW)).toBeUndefined();
		// With no builder, it would run here, past the CPU line.
		expect(waitReasons([...checking, build], pressed, NOW).get("build")).toBe(
			"busy",
		);

		const oneSlot = { ...pressed, offload: { builds: 1, vms: 0 } };
		expect(nextTurn([...checking, build], oneSlot, NOW)?.id).toBe("build");

		// Once a build there takes the slot, the builder reads it busy.
		const there = job("there", { started: long, capped: true });
		const taken = { ...pressed, offload: { builds: 0, vms: 0 } };
		expect(nextTurn([...checking, there, build], taken, NOW)).toBeUndefined();
	});

	it("leaves the one build here beside a VM check when the machine has room", () => {
		const checking = [job("vm", { kind: "vm-check", started: long })];
		const calm = { ...ROOMY, vms: 1, offload: { builds: 1, vms: 0 } };
		const running = [
			job("here", { started: long, capped: true }),
			job("there", { started: long, capped: true }),
		];
		expect(
			nextTurn([...checking, running[0] as Job, job("next")], calm, NOW)?.id,
		).toBe("next");
		const taken = { ...calm, offload: { builds: 0, vms: 0 } };
		expect(
			nextTurn([...checking, ...running, job("next")], taken, NOW),
		).toBeUndefined();
	});
});
