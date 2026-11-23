import {
	existsSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import {
	FAILURES_TO_LOWER_VMS,
	keepOutcome,
	NOTHING_BESIDE,
	outcomeOf,
} from "../../../../lib/internal/priority/outcome.ts";
import {
	type Job,
	MOST_MEMORY_PRESSURE,
	MOST_VMS,
} from "../../../../lib/internal/priority/queue.ts";
import {
	dir,
	freshFolderEachTest,
	job,
	NOW,
	processes,
	ROOMY,
	record,
	running,
	shellSays,
} from "./queue-folder.ts";

freshFolderEachTest();

describe("the machine's queue folder", () => {
	it("keeps a job the boot cut off as ended at the boot, not when it was seen", async () => {
		// A Mac's queue folder outlasts a reboot, so the first keep after one
		// can come hours after the job's shell was ended by it.
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const booted = NOW - 3_600_000;
		const queue = queueFolder(
			dir,
			{ ...processes, bootedAt: () => booted },
			undefined,
			file,
		);
		const started = booted - 120_000;
		queue.ask(
			job("cut", {
				since: new Date(started - 1000).toISOString(),
				started: new Date(started).toISOString(),
			}),
		);
		shellSays("cut", 100);
		queue.keep(ROOMY, NOW, () => undefined);
		await queue.outcomesKept();
		const [kept] = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(kept).toMatchObject({
			id: "cut",
			ended: new Date(booted).toISOString(),
			ranS: 120,
		});
	});

	it("answers the fetches of main waiting on one that moved origin/main, for a minute after", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const world = join(dir, "..", "world", "git");
		const queue = queueFolder(
			dir,
			processes,
			undefined,
			file,
			undefined,
			world,
		);
		const fetch = (id: string, over: Partial<Job> = {}) =>
			job(id, {
				kind: "world-walk",
				what: "git fetch -q origin main",
				walk: "main-fetch",
				...over,
			});
		queue.ask(
			fetch("fetching", { started: new Date(NOW - 120_000).toISOString() }),
		);
		queue.ask(fetch("main"));
		shellSays("fetching", 601);
		shellSays("main", 602);
		queue.keep(ROOMY, NOW, () => undefined);
		expect(
			queue.hasTurn("main"),
			"a fetch of main waits while another is running",
		).toBe(false);

		// Its shell read origin/main as it began and as it ended.
		writeFileSync(join(dir, "fetching.main-before"), `${"a".repeat(40)}\n`);
		writeFileSync(join(dir, "fetching.main-after"), `${"b".repeat(40)}\n`);
		writeFileSync(join(dir, "fetching.end"), "1\n");
		running.delete(601);
		queue.keep(ROOMY, NOW + 5_000, () => undefined);
		expect(
			queue.hasTurn("main"),
			"the waiting fetch is answered once the running one moved main",
		).toBe(true);
		expect(readFileSync(join(dir, "main.fetched"), "utf8")).toBe("fetching\n");
		const given = JSON.parse(readFileSync(join(dir, "main.job"), "utf8"));
		expect(given).toMatchObject({ answered: true });
		const wrapper = readFileSync(join(dir, "fetched", "git"), "utf8");
		expect(wrapper).toContain(`'${world}'`);
		expect(statSync(join(dir, "fetched", "git")).mode & 0o111).not.toBe(0);
		// Piped into grep, its exit said 1: the ref it moved is what counts.
		await queue.outcomesKept();
		const [made] = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(made).toMatchObject({
			id: "fetching",
			walk: "main-fetch",
			movedMain: true,
		});

		// One asked within the minute is answered too; one after takes its turn.
		queue.ask(fetch("soon"));
		shellSays("soon", 603);
		queue.keep(ROOMY, NOW + 30_000, () => undefined);
		const soon = join(dir, "soon.fetched");
		expect(
			existsSync(soon),
			`${soon} answers a fetch asked within the minute`,
		).toBe(true);
		queue.ask(fetch("late"));
		shellSays("late", 604);
		queue.keep(ROOMY, NOW + 70_000, () => undefined);
		expect(
			queue.hasTurn("late"),
			"a fetch asked after the minute takes its own turn",
		).toBe(true);
		const late = join(dir, "late.fetched");
		expect(
			existsSync(late),
			`${late} is not written for a fetch asked after the minute`,
		).toBe(false);
	});

	it("leaves the fetches of main waiting to their own turns when the one running moved nothing", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const world = join(dir, "..", "world", "git");
		const queue = queueFolder(
			dir,
			processes,
			undefined,
			file,
			undefined,
			world,
		);
		const fetch = (id: string, over: Partial<Job> = {}) =>
			job(id, {
				kind: "world-walk",
				what: "git fetch origin main",
				walk: "main-fetch",
				...over,
			});
		queue.ask(
			fetch("fetching", { started: new Date(NOW - 120_000).toISOString() }),
		);
		queue.ask(fetch("main"));
		shellSays("fetching", 601);
		shellSays("main", 602);
		writeFileSync(join(dir, "fetching.main-before"), `${"a".repeat(40)}\n`);
		writeFileSync(join(dir, "fetching.main-after"), `${"a".repeat(40)}\n`);
		running.delete(601);
		queue.keep(ROOMY, NOW, () => undefined);
		expect(queue.hasTurn("main"), "the waiting fetch takes its own turn").toBe(
			true,
		);
		const fetched = join(dir, "main.fetched");
		expect(
			existsSync(fetched),
			`${fetched} is not written when the running fetch moved nothing`,
		).toBe(false);
		// The ended fetch's outcome is still being written, and the folder it
		// goes in is removed after each test.
		await queue.outcomesKept();
	});

	it("keeps how each job ended and what ran beside it", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		// The check passed before, with no capped build beside it.
		const before = new Date(NOW - 600_000).toISOString();
		await keepOutcome(
			file,
			outcomeOf(job("before", { kind: "vm-check", started: before }), NOW, 0),
		);
		const queue = queueFolder(
			dir,
			{ isRunning: (pid) => running.has(pid), cgroupOf: () => undefined },
			undefined,
			file,
		);
		const ran = new Date(NOW - 120_000).toISOString();
		queue.ask(job("check", { kind: "vm-check", started: ran }));
		queue.ask(job("build"));
		shellSays("check", 601);
		shellSays("build", 602);
		const vm = { ...ROOMY, vms: 1 };
		queue.keep(vm, NOW, () => undefined);
		expect(readFileSync(join(dir, "capped.conf"), "utf8")).toBe(
			"max-jobs = 2\ncores = 4\n",
		);
		queue.keep({ ...vm, cpuPressure: 7 }, NOW + 3_000, () => undefined);
		queue.keep(vm, NOW + 4_000, () => undefined);
		writeFileSync(join(dir, "check.end"), "1\n");
		utimesSync(
			join(dir, "check.end"),
			(NOW + 5_000) / 1000,
			(NOW + 5_000) / 1000,
		);
		running.delete(601);
		running.delete(602);
		queue.ask(job("next"));
		shellSays("next", 603);
		queue.keep(vm, NOW + 9_000, () => undefined);
		await queue.outcomesKept();
		const [, ...kept] = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(kept).toEqual([
			expect.objectContaining({ id: "build", capped: true, ranS: 9 }),
			expect.objectContaining({
				id: "check",
				kind: "vm-check",
				exit: 1,
				ranS: 125,
				beside: { vms: 1, builds: 1, cappedBuilds: 1, cpuPressure: 7 },
			}),
		]);
		expect(kept[0]).not.toHaveProperty("exit");
		const ended = join(dir, "check.end");
		expect(existsSync(ended), `${ended} is cleared once kept`).toBe(false);
		// A VM failed beside a capped build, so the next one gets fewer cores.
		expect(queue.hasTurn("next"), "the next job has its turn").toBe(true);
		expect(readFileSync(join(dir, "capped.conf"), "utf8")).toBe(
			"max-jobs = 2\ncores = 2\n",
		);
	});

	it("keeps what each job waited on, writing its file only as the reason changes", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const queue = queueFolder(
			dir,
			{ isRunning: (pid) => running.has(pid), cgroupOf: () => undefined },
			undefined,
			file,
		);
		queue.ask(job("test", { kind: "vm-test" }));
		shellSays("test", 701);
		const full = { ...ROOMY, vms: MOST_VMS };
		const jobFile = join(dir, "test.job");

		queue.keep(full, NOW, () => undefined);
		const noted = readFileSync(jobFile, "utf8");
		queue.keep(full, NOW + 9_000, () => undefined);
		expect(readFileSync(jobFile, "utf8")).toBe(noted);
		queue.keep(
			{ ...full, memoryPressure: MOST_MEMORY_PRESSURE },
			NOW + 19_000,
			() => undefined,
		);
		queue.keep(ROOMY, NOW + 24_000, () => undefined);
		expect(
			queue.hasTurn("test"),
			"the VM test has its turn once there is room",
		).toBe(true);
		writeFileSync(join(dir, "test.end"), "0\n");
		utimesSync(
			join(dir, "test.end"),
			(NOW + 30_000) / 1000,
			(NOW + 30_000) / 1000,
		);
		running.delete(701);
		queue.keep(ROOMY, NOW + 31_000, () => undefined);

		await queue.outcomesKept();
		const [kept] = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		// Asked a second before the first look: 20 s on a VM slot, then 5 s
		// on memory until its turn.
		expect(kept).toMatchObject({
			id: "test",
			waitedS: 25,
			waitedOn: { vms: 20, memory: 5 },
		});
	});

	it("records the most memory a job's own commands held, from its scope", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const GIB = 1024 ** 3;
		// A VM test run from its driver: qemu runs in the job's own scope, so
		// none of its memory is a Nix build's.
		const peaks = new Map([["/work-801.scope", 5 * GIB]]);
		const queue = queueFolder(
			dir,
			{
				isRunning: (pid) => running.has(pid),
				cgroupOf: (pid) => `/work-${pid}.scope`,
				ownedPeakOf: (cgroup, shell) =>
					cgroup === `/work-${shell}.scope` ? peaks.get(cgroup) : undefined,
			},
			undefined,
			file,
		);
		const ran = new Date(NOW - 60_000).toISOString();
		queue.ask(
			job("driver", {
				kind: "vm-test",
				what: "nixos-test-driver",
				started: ran,
			}),
		);
		queue.ask(job("unread", { what: "cargo build", started: ran }));
		shellSays("driver", 801);
		shellSays("unread", 802);
		queue.keep(ROOMY, NOW, () => undefined);
		// A reading that comes back lower, as a scope remade would, never
		// lowers what was seen.
		peaks.set("/work-801.scope", 2 * GIB);
		queue.keep(ROOMY, NOW + 3_000, () => undefined);
		running.delete(801);
		running.delete(802);
		queue.keep(ROOMY, NOW + 6_000, () => undefined);
		await queue.outcomesKept();
		const kept = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const driver = kept.find((outcome) => outcome.id === "driver");
		const unread = kept.find((outcome) => outcome.id === "unread");
		expect(driver).toMatchObject({ ownedPeakBytes: 5 * GIB });
		expect(driver).not.toHaveProperty("buildsPeakBytes");
		// A scope whose peak can't be read says nothing, rather than nought.
		expect(unread).not.toHaveProperty("ownedPeakBytes");
	});

	it("records no peak from a scope its shell shares with other work", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		// 10 November: 397 outcomes held exactly the work service's own
		// memory.peak, 10,804,027,392 bytes, read while each job's shell
		// still sat there with every other job's.
		const queue = queueFolder(
			dir,
			{
				isRunning: (pid) => running.has(pid),
				cgroupOf: () => "/jobs.slice/jobs.service",
				ownedPeakOf: () => undefined,
			},
			undefined,
			file,
		);
		const ran = new Date(NOW - 60_000).toISOString();
		queue.ask(job("shared", { what: "cargo build", started: ran }));
		shellSays("shared", 803);
		queue.keep(ROOMY, NOW, () => undefined);
		running.delete(803);
		queue.keep(ROOMY, NOW + 3_000, () => undefined);
		await queue.outcomesKept();
		const kept = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(kept.find((outcome) => outcome.id === "shared")).not.toHaveProperty(
			"ownedPeakBytes",
		);
	});

	it("says how long a VM job held its slot before a VM of its own ran", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const commands = new Map<string, string[]>();
		const queue = queueFolder(
			dir,
			{
				isRunning: (pid) => running.has(pid),
				cgroupOf: (pid) => `/work-${pid}.scope`,
				commandsIn: (cgroup) => commands.get(cgroup) ?? [],
			},
			undefined,
			file,
		);
		const ran = new Date(NOW - 60_000).toISOString();
		queue.ask(job("check", { kind: "vm-check", started: ran }));
		queue.ask(job("test", { kind: "vm-test", started: ran }));
		queue.ask(job("none", { kind: "vm-check", started: ran }));
		shellSays("check", 901);
		shellSays("test", 902);
		shellSays("none", 903);
		const building = [
			{ asker: "/work-901.scope", timed: false, memoryPeak: 1 },
		];
		commands.set("/work-902.scope", ["bash -c run-subtests"]);
		queue.keep({ ...ROOMY, builds: building }, NOW, () => undefined);

		// Half a minute on, the check's VM runs as a build with deadlines,
		// and the test's driver has started its qemu.
		commands.set("/work-902.scope", [
			"bash -c run-subtests",
			"/nix/store/abc-qemu-9.2.0/bin/qemu-system-x86_64 -name machine",
		]);
		const vm = [{ asker: "/work-901.scope", timed: true, memoryPeak: 1 }];
		queue.keep({ ...ROOMY, builds: vm }, NOW + 30_000, () => undefined);
		// The first sight holds, whatever comes after.
		queue.keep({ ...ROOMY, builds: vm }, NOW + 40_000, () => undefined);
		for (const pid of [901, 902, 903]) running.delete(pid);
		queue.keep(ROOMY, NOW + 45_000, () => undefined);

		await queue.outcomesKept();
		const kept = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const of = (id: string) => kept.find((outcome) => outcome.id === id);
		expect(of("check")).toMatchObject({ vmAfterS: 90 });
		expect(of("test")).toMatchObject({ vmAfterS: 90 });
		expect(of("none")).not.toHaveProperty("vmAfterS");
	});

	it("learns from a job's builds whether it runs a check with deadlines, and how much memory they held", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const GIB = 1024 ** 3;
		const queue = queueFolder(
			dir,
			{
				isRunning: (pid) => running.has(pid),
				cgroupOf: (pid) => `/work-${pid}.scope`,
			},
			undefined,
			file,
		);
		const ran = new Date(NOW - 60_000).toISOString();
		queue.ask(job("flake", { what: "nix flake check", started: ran }));
		queue.ask(job("other", { what: "cargo build", started: ran }));
		shellSays("flake", 801);
		shellSays("other", 802);
		// The flake check's second build runs a VM; a build nobody is known to
		// have asked for counts for no job.
		queue.keep(
			{
				...ROOMY,
				builds: [
					{ asker: "/work-801.scope", timed: false, memoryPeak: 2 * GIB },
					{ asker: "/work-801.scope", timed: true, memoryPeak: 3 * GIB },
					{ asker: "/work-802.scope", timed: false, memoryPeak: GIB },
					{ timed: true, memoryPeak: 9 * GIB },
				],
			},
			NOW,
			() => undefined,
		);
		// Later its VM has finished, and less is held: the most is kept.
		queue.keep(
			{
				...ROOMY,
				builds: [{ asker: "/work-801.scope", timed: false, memoryPeak: GIB }],
			},
			NOW + 3_000,
			() => undefined,
		);
		running.delete(801);
		running.delete(802);
		queue.keep(ROOMY, NOW + 6_000, () => undefined);
		await queue.outcomesKept();
		const kept = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const flake = kept.find((outcome) => outcome.id === "flake");
		const other = kept.find((outcome) => outcome.id === "other");
		expect(flake).toMatchObject({ ranTimed: true, buildsPeakBytes: 5 * GIB });
		expect(other).toMatchObject({ buildsPeakBytes: GIB });
		expect(other).not.toHaveProperty("ranTimed");

		// Asked again, the flake check waits as a VM check; the rest as they were.
		expect(queue.kindFor("build", "nix flake check")).toBe("vm-check");
		expect(queue.kindFor("build", "cargo build")).toBe("build");
		expect(queue.kindFor("build", "nix build .#never-ran")).toBe("build");
		expect(queue.kindFor("benchmark", "nix flake check")).toBe("benchmark");
		// A run that gave up waiting says nothing about what the work runs.
		await keepOutcome(
			file,
			outcomeOf(job("gave-up", { what: "nix flake check" }), NOW + 7_000, 0),
		);
		expect(queue.kindFor("build", "nix flake check")).toBe("vm-check");
		// Its latest run built no check with deadlines, all cached, so it is a
		// build again.
		await keepOutcome(
			file,
			outcomeOf(
				job("cached", { what: "nix flake check", started: ran }),
				NOW + 8_000,
				0,
			),
		);
		expect(queue.kindFor("build", "nix flake check")).toBe("build");
	});

	it("runs fewer VMs while the outcomes say the most was too many", async () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const check = (id: string, exit: number, vms: number) => ({
			...outcomeOf(
				job(id, { kind: "vm-check", started: new Date(NOW).toISOString() }),
				NOW + 60_000,
				exit,
			),
			beside: { ...NOTHING_BESIDE, vms },
		});
		await keepOutcome(file, check("passed", 0, MOST_VMS - 1));
		for (let at = 0; at < FAILURES_TO_LOWER_VMS; at += 1) {
			await keepOutcome(file, check(`failed${at}`, 1, MOST_VMS));
		}
		const queue = queueFolder(
			dir,
			{ isRunning: (pid) => running.has(pid), cgroupOf: () => undefined },
			undefined,
			file,
		);
		const ran = new Date(NOW - 120_000).toISOString();
		const vms = Array.from({ length: MOST_VMS - 1 }, (_, at) => `vm${at}`);
		for (const [at, id] of vms.entries()) {
			queue.ask(job(id, { kind: "vm-check", started: ran }));
			shellSays(id, 700 + at);
		}
		const machine = { ...ROOMY, vms: MOST_VMS - 1 };
		queue.keep(machine, NOW + 110_000, () => undefined);
		expect(record().room.vms).toBe(0);
		queue.ask(job("last", { kind: "vm-check" }));
		shellSays("last", 799);
		queue.keep(machine, NOW + 120_000, () => undefined);
		expect(
			queue.hasTurn("last"),
			"one VM fewer may run after checks failed at the most",
		).toBe(false);
		// The failure is read out of the file again once it has changed.
		writeFileSync(
			file,
			`${JSON.stringify(check("passed", 0, MOST_VMS - 1))}\n`,
		);
		queue.keep(machine, NOW + 130_000, () => undefined);
		expect(
			queue.hasTurn("last"),
			"the full count returns once the file says a check passed",
		).toBe(true);
	});
});
