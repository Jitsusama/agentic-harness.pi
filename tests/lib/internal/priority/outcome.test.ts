import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	capFor,
	FAILURES_COUNT_FOR_MS,
	failed,
	keepOutcome,
	MOST_OUTCOME_BYTES,
	NOTHING_BESIDE,
	type Outcome,
	outcomeOf,
	outcomesIn,
	vmsFor,
} from "../../../../lib/internal/priority/outcome.ts";
import {
	FEWER_VMS,
	type Job,
	MOST_VMS,
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
