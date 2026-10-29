import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	capFor,
	FAILURES_COUNT_FOR_MS,
	failed,
	HEADROOM,
	keepOutcome,
	kindAfter,
	MOST_OUTCOME_BYTES,
	NOTHING_BESIDE,
	type Outcome,
	outcomeOf,
	outcomesIn,
	peakGibAfter,
	QUICK_S,
	quickAfter,
	RUNS_READ,
	ranSAfter,
	TELLING_S,
	vmsFor,
	workKey,
} from "../../../../lib/internal/priority/outcome.ts";
import {
	FEWER_VMS,
	type Job,
	MOST_VMS,
	needsGibOfCommand,
} from "../../../../lib/internal/priority/queue.ts";

const NOW = Date.parse("2026-10-22T18:00:00Z");

const job = (over: Partial<Job> = {}): Job => ({
	id: "j",
	kind: "vm-check",
	what: "nix build .#checks.x86_64-linux.desktop",
	owner: { session: "s", pid: 1 },
	since: new Date(NOW - 60_000).toISOString(),
	...over,
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
	...outcomeOf(job({ started: new Date(NOW - 30_000).toISOString() }), NOW, 1),
	beside: { ...NOTHING_BESIDE, vms: 1, cappedBuilds: 1 },
	...over,
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "outcomes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("work that takes seconds", () => {
	const ran = (what: string, ranS: number): Outcome =>
		outcome({ kind: "build", what, ranS });

	it("knows work again whatever flake reference or wrapper it came with", () => {
		expect(
			workKey(
				'nix build --no-link "git+file://$PWD?rev=$rev#checks.x86_64-linux.b" .#checks.x86_64-linux.a',
			),
		).toBe(workKey('nix build "path:$T#checks.x86_64-linux.a" .#checks.x.b'));
		expect(workKey("timeout 600 direnv exec . cargo test -p walgit")).toBe(
			workKey("cargo test -p walgit"),
		);
	});

	it("is a build whose last run was quick, or that builds checks and no VM", () => {
		const check = "nix build .#checks.x86_64-linux.formatting";
		expect(quickAfter("build", check, [])).toBe(true);
		expect(quickAfter("build", check, [ran(check, QUICK_S)])).toBe(false);
		expect(
			quickAfter("build", check, [ran(check, QUICK_S), ran(check, 4)]),
		).toBe(true);
		expect(quickAfter("build", "cargo test", [])).toBe(false);
		expect(quickAfter("build", "cargo test", [ran("cargo test", 9)])).toBe(
			true,
		);
		expect(
			quickAfter("build", "nix build .#checks.x86_64-linux.vm-desktop", []),
		).toBe(false);
		expect(quickAfter("vm-check", check, [ran(check, 4)])).toBe(false);
		const waited = outcome({ kind: "build", what: check, ranS: undefined });
		expect(quickAfter("build", check, [ran(check, 600), waited])).toBe(false);
	});
});

describe("work that runs VMs, whatever it is named", () => {
	const built = (what: string, ranTimed: boolean): Outcome =>
		outcome({
			kind: "build",
			what,
			ranS: 600,
			...(ranTimed ? { ranTimed: true as const } : {}),
		});
	const bluetooth =
		"direnv exec . nix build --no-link -L .#checks.x86_64-linux.bluetooth-sits-out-hibernation > $TMPDIR/bt.log 2>&1";

	it("waits as a VM check when the same checks last ran one, however it was asked", () => {
		const again =
			'nix build --no-link "path:$T#checks.x86_64-linux.bluetooth-sits-out-hibernation" > $W/bt2.log';

		expect(kindAfter("build", again, [built(bluetooth, true)])).toBe(
			"vm-check",
		);
		// From the cache the next time, it is a build again.
		expect(
			kindAfter("build", again, [built(bluetooth, true), built(again, false)]),
		).toBe("build");
	});

	it("knows a check that ran a VM built alone, in any command that names it", () => {
		// 28 October: the net built VM checks named like this one beside its
		// others as a build, and seven VMs ran with no VM turn while twenty
		// VM tests waited.
		const arrival =
			"direnv exec . nix build --no-link -L $c.an-arrival-is-said-once-each-time > $TMPDIR/r-arr.log 2>&1";
		const net =
			"nix build --no-link --keep-going $c.quickshell-passes-qmllint $c.an-arrival-is-said-once-each-time";
		const named =
			"nix build --no-link .#checks.x86_64-linux.an-arrival-is-said-once-each-time";

		expect(kindAfter("build", net, [built(arrival, true)])).toBe("vm-check");
		expect(kindAfter("build", named, [built(arrival, true)])).toBe("vm-check");
		expect(quickAfter("build", named, [built(arrival, true)])).toBe(false);
		expect(
			kindAfter("build", "nix build $c.formatting", [built(arrival, true)]),
		).toBe("build");
	});

	it("learns nothing of each check from a run of several that ran a VM", () => {
		const both =
			"nix build $c.an-arrival-is-said-once-each-time $c.quickshell-passes-qmllint";

		expect(
			kindAfter("build", "nix build $c.quickshell-passes-qmllint", [
				built(both, true),
			]),
		).toBe("build");
	});

	it("goes by a check's latest run alone", () => {
		const cached = bluetooth.replace("bt.log", "bt3.log");
		const net = "nix build $c.bluetooth-sits-out-hibernation $c.formatting";

		expect(
			kindAfter("build", net, [built(bluetooth, true), built(cached, false)]),
		).toBe("build");
	});
});

describe("how long work took last time", () => {
	const check = "nix build .#checks.x86_64-linux.formatting > $TMPDIR/a.log";

	it("is the latest run that had its turn, wherever its output went", () => {
		const runs = [
			outcome({ what: check, ranS: 300, exit: 0 }),
			outcome({
				what: "nix build .#checks.x86_64-linux.formatting > b",
				ranS: 240,
				exit: 0,
			}),
			outcome({ what: check, ranS: undefined }),
		];
		expect(ranSAfter(check, runs)).toBe(240);
	});

	it("passes over a failure too quick to say how long the work takes", () => {
		const runs = [
			outcome({ what: check, ranS: 300, exit: 0 }),
			outcome({ what: check, ranS: TELLING_S - 1, exit: 1 }),
		];
		expect(ranSAfter(check, runs)).toBe(300);
		expect(ranSAfter("cargo test", runs)).toBeUndefined();
	});
});

describe("the memory work needs, by its latest runs", () => {
	const GIB = 1024 ** 3;
	const ran = (what: string, gib: number, over: Partial<Outcome> = {}) =>
		outcome({
			kind: "build",
			what,
			ranS: 300,
			exit: 0,
			ownPeakBytes: gib * GIB,
			...over,
		});

	it("knows work again whatever log it sends its output to", () => {
		expect(
			workKey(
				"nix develop -c changed-checks --no-vm > $L/sub-changed.txt 2>&1",
			),
		).toBe(
			workKey("nix develop -c changed-checks --no-vm >$L/talk.txt 2>>err"),
		);
	});

	it("is the most its own commands held in its latest runs, with headroom", () => {
		const check = "direnv exec . nix flake check --no-build --all-systems";
		const runs = [
			ran(check, 12),
			ran(`${check} > $TMPDIR/core-fc.log 2>&1`, 20),
			ran(check, 16),
		];

		expect(peakGibAfter(check, runs)).toBe(Math.ceil(20 * HEADROOM));
	});

	it("forgets what runs before its latest few held", () => {
		const check = "nix flake check --keep-going";
		const runs = [
			ran(check, 30),
			...Array.from({ length: RUNS_READ }, () => ran(check, 5)),
		];

		expect(peakGibAfter(check, runs)).toBe(Math.ceil(5 * HEADROOM));
	});

	it("is nothing for work never seen, so its kind's guess stands", () => {
		expect(peakGibAfter("cargo test -p walgit", [ran("cargo build", 9)])).toBe(
			undefined,
		);
	});

	it("passes over a run that failed too soon to say anything", () => {
		const test = 'nix develop "path:$d" -c cargo test';
		const runs = [
			ran(test, 10.9),
			ran(test, 0.2, { exit: 1, ranS: TELLING_S - 1 }),
		];

		expect(peakGibAfter(test, runs)).toBe(Math.ceil(10.9 * HEADROOM));
	});

	it("holds the forms 5FWIUS found to the whole flake's guess until they have run", () => {
		for (const [command, gib] of [
			[
				"direnv exec . nix flake check --no-build --all-systems > $T/fc.log 2>&1",
				20,
			],
			['nix flake check --keep-going "path:$PWD" > $ws/check.log 2>&1', 20],
			[
				'nix eval --json "path:$zc#checks.x86_64-linux" --apply builtins.attrNames',
				24,
			],
			[
				"timeout 2700 nix develop -c changed-checks --build --no-vm > $T/cc.log 2>&1",
				16,
			],
		] as const) {
			expect(needsGibOfCommand("build", command)).toBe(gib);
		}
	});
});

describe("how heavy work ended", () => {
	it("says how long a job waited and ran, and how it exited", () => {
		const started = new Date(NOW - 30_000).toISOString();
		expect(outcomeOf(job({ started, capped: true }), NOW, 0)).toMatchObject({
			waitedS: 30,
			ranS: 30,
			exit: 0,
			capped: true,
			class: "bulk",
			beside: NOTHING_BESIDE,
		});
		const gaveUp = outcomeOf(job(), NOW, undefined);
		expect(gaveUp.waitedS).toBe(60);
		expect(gaveUp).not.toHaveProperty("ranS");
		expect(gaveUp).not.toHaveProperty("exit");
	});

	it("counts a failure only when the work said so", () => {
		expect([0, 1, 124, 125, 126, 130, undefined].map(failed)).toEqual([
			false,
			true,
			true,
			true,
			false,
			false,
			false,
		]);
	});

	it("lowers the cap for a day after a VM that passed alone fails beside one", () => {
		const alone = { ...NOTHING_BESIDE, vms: 1 };
		const passedAlone = outcome({ id: "p", exit: 0, beside: alone });
		expect(capFor([], NOW)).toEqual({ maxJobs: 2, cores: 4 });
		expect(capFor([passedAlone, outcome()], NOW)).toEqual({
			maxJobs: 2,
			cores: 2,
		});
		// A break copy fails every time, so its failure beside a cap says
		// nothing about the cap.
		expect(capFor([outcome()], NOW)).toEqual({ maxJobs: 2, cores: 4 });
		const elsewhere = { ...passedAlone, what: "nix build .#checks.other" };
		const besideCap = outcome({ exit: 0 });
		for (const pass of [elsewhere, besideCap]) {
			expect(capFor([pass, outcome()], NOW)).toEqual({ maxJobs: 2, cores: 4 });
		}
		const passed = outcome({ exit: 0 });
		const stopped = outcome({ exit: 130 });
		const lone = outcome({ beside: alone });
		const build = outcome({ kind: "build" });
		const old = outcome({
			ended: new Date(NOW - FAILURES_COUNT_FOR_MS - 1).toISOString(),
		});
		for (const one of [passed, stopped, lone, build, old]) {
			expect(capFor([passedAlone, one], NOW)).toEqual({
				maxJobs: 2,
				cores: 4,
			});
		}
	});

	it("runs fewer VMs for a day once VMs fail more often at the most than with fewer", () => {
		const fewer = { ...NOTHING_BESIDE, vms: MOST_VMS - 1 };
		const most = { ...NOTHING_BESIDE, vms: MOST_VMS };
		const passedWithFewer = Array.from({ length: 10 }, (_, n) =>
			outcome({ id: `p${n}`, exit: 0, beside: fewer }),
		);
		const failedAtMost = (n: number) =>
			Array.from({ length: n }, (_, k) =>
				outcome({ id: `f${k}`, beside: most }),
			);
		expect(vmsFor([], NOW)).toBe(MOST_VMS);
		expect(vmsFor([...passedWithFewer, ...failedAtMost(3)], NOW)).toBe(
			FEWER_VMS,
		);
		// On 24 October one work-in-progress check failing, an assertion in
		// 86 s, held the limit down for a day while 623 runs over two days
		// failed no more often with eight VMs beside them than with one.
		expect(vmsFor([...passedWithFewer, ...failedAtMost(1)], NOW)).toBe(
			MOST_VMS,
		);
		// Failing as often with fewer, the crowd isn't what fails them.
		const failedWithFewer = Array.from({ length: 3 }, (_, n) =>
			outcome({ id: `w${n}`, beside: fewer }),
		);
		const passedAtMost = Array.from({ length: 7 }, (_, n) =>
			outcome({ id: `m${n}`, exit: 0, beside: most }),
		);
		expect(
			vmsFor(
				[
					...passedWithFewer.slice(0, 7),
					...failedWithFewer,
					...passedAtMost,
					...failedAtMost(3),
				],
				NOW,
			),
		).toBe(MOST_VMS);
		// A break copy fails however few run, so it says nothing of the limit.
		expect(vmsFor(failedAtMost(3), NOW)).toBe(MOST_VMS);
		const elsewhere = passedWithFewer.map((pass) => ({
			...pass,
			what: "nix build .#checks.other",
		}));
		expect(vmsFor([...elsewhere, ...failedAtMost(3)], NOW)).toBe(MOST_VMS);
		const stopped = outcome({ exit: 130, beside: most });
		const build = outcome({ kind: "build", beside: most });
		const old = outcome({
			beside: most,
			ended: new Date(NOW - FAILURES_COUNT_FOR_MS - 1).toISOString(),
		});
		for (const one of [stopped, build, old]) {
			expect(vmsFor([...passedWithFewer, ...failedAtMost(2), one], NOW)).toBe(
				MOST_VMS,
			);
		}
	});

	it("keeps the newer half once the file is full, and reads what it can", () => {
		const file = join(dir, "state", "outcomes.jsonl");
		const big = "x".repeat(MOST_OUTCOME_BYTES / 4);
		for (const id of ["a", "b", "c", "d", "e"]) {
			keepOutcome(file, outcome({ id, what: big }));
		}
		expect(outcomesIn(file).map((one) => one.id)).toEqual(["c", "d", "e"]);
		writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"v":2}\n`);
		expect(outcomesIn(file)).toHaveLength(3);
		expect(outcomesIn(join(dir, "none"))).toEqual([]);
	});
});
