import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tellAwaited } from "../../../../lib/internal/priority/awaited.ts";
import {
	KEPT_FOR_MS,
	PID_MS,
	QUEUE_FIRST_FILE,
	queueFolder,
	UNSTAMPED_BOOT_SLACK_MS,
} from "../../../../lib/internal/priority/folder.ts";
import { NEWER_KEEPER_MS } from "../../../../lib/internal/priority/keeper.ts";
import {
	MOST_CPU_PRESSURE_BESIDE_VMS,
	MOST_MEMORY_PRESSURE,
	MOST_MEMORY_STALL_FOR_ONE,
	MOST_VMS,
	SPREAD_MS,
} from "../../../../lib/internal/priority/queue.ts";
import {
	dir,
	folder,
	freshFolderEachTest,
	job,
	NOW,
	processes,
	ROOMY,
	record,
	running,
	shellSays,
	TIGHT,
} from "./queue-folder.ts";

freshFolderEachTest();

describe("the machine's queue folder", () => {
	it("leaves keeping to a session on newer rules while that one keeps", () => {
		// 18:00 on 29 October: sessions on code from before VM starts were
		// paced kept the queue, and six VMs started in 2.5 minutes.
		const newer = queueFolder(dir, processes, undefined, undefined, 2);
		const older = queueFolder(dir, processes, undefined, undefined, 1);
		newer.keep(ROOMY, NOW, () => undefined);

		older.ask(job("build"));
		older.keep(ROOMY, NOW + 1_000, () => undefined);
		expect(
			older.hasTurn("build"),
			"the older keeper gives build no turn while the newer one keeps",
		).toBe(false);
		newer.keep(ROOMY, NOW + 2_000, () => undefined);
		expect(
			newer.hasTurn("build"),
			"the newer keeper gives build its turn",
		).toBe(true);
	});

	it("keeps on older rules once no newer session has kept for a minute", () => {
		// As after the install is rolled back.
		queueFolder(dir, processes, undefined, undefined, 2).keep(
			ROOMY,
			NOW,
			() => undefined,
		);
		const older = queueFolder(dir, processes, undefined, undefined, 1);
		const later = NOW + NEWER_KEEPER_MS;
		older.ask(job("next", { since: new Date(later - 1_000).toISOString() }));
		older.keep(ROOMY, later, () => undefined);
		expect(
			older.hasTurn("next"),
			"the older keeper gives next its turn once the newer one is quiet",
		).toBe(true);
	});

	it("counts a folder kept a moment ago, with nothing come or gone, as kept", () => {
		// 5 November: every session kept it in turn, and the lock was held
		// 96% of the time.
		const queue = folder();
		queue.ask(job("build"));
		shellSays("build", 300);
		expect(queue.keptFresh(NOW), "a folder never kept is not kept").toBe(false);

		queue.keep(ROOMY, NOW, () => undefined);

		expect(
			queue.keptFresh(NOW + KEPT_FOR_MS - 1),
			"a folder kept just under KEPT_FOR_MS ago is kept",
		).toBe(true);
		expect(
			queue.keptFresh(NOW + KEPT_FOR_MS),
			"a folder kept KEPT_FOR_MS ago is not kept",
		).toBe(false);
	});

	it("counts a folder a job came into since its keep as not kept", () => {
		const queue = folder();
		queue.ask(job("build"));
		queue.keep(ROOMY, NOW, () => undefined);

		queue.ask(job("next"));

		expect(
			queue.keptFresh(NOW + 1),
			"a folder a job came into since its keep is not kept",
		).toBe(false);
	});

	it("counts a folder a job's end came into since its keep as not kept", () => {
		const queue = folder();
		queue.ask(job("build"));
		queue.keep(ROOMY, NOW, () => undefined);

		writeFileSync(join(dir, "build.end"), "0\n");

		expect(
			queue.keptFresh(NOW + 1),
			"a folder a job's end came into since its keep is not kept",
		).toBe(false);
	});

	it("says it kept the folder only where the desktop's watch can't hear", () => {
		const queue = folder();
		queue.ask(job("build"));

		queue.keep(ROOMY, NOW, () => undefined);

		const heard = join(dir, "kept.json");
		const unheard = join(dir, "locks", "kept.json");
		expect(
			existsSync(heard),
			`${heard}, where the desktop's watch hears, is not written`,
		).toBe(false);
		expect(existsSync(unheard), `${unheard} is written`).toBe(true);
	});

	it("leaves a folder a newer keeper keeps unmarked by an older one", () => {
		const newer = queueFolder(dir, processes, undefined, undefined, 2);
		const older = queueFolder(dir, processes, undefined, undefined, 1);
		newer.ask(job("build"));
		newer.keep(ROOMY, NOW, () => undefined);

		older.keep(ROOMY, NOW + KEPT_FOR_MS, () => undefined);

		expect(
			older.keptFresh(NOW + KEPT_FOR_MS),
			"the older keeper's keep did not mark the folder kept",
		).toBe(false);
	});

	it("holds a job while it plans, then queues it as what its plan found", () => {
		const queue = folder();
		queue.ask(job("cached", { kind: "vm-check", planning: true }));
		shellSays("cached", 300);

		queue.keep({ ...ROOMY, vms: MOST_VMS }, NOW, () => undefined);
		expect(queue.hasTurn("cached"), "a job still planning has no turn").toBe(
			false,
		);
		expect(record().jobs[0]).toMatchObject({ waitingOn: "planning" });
		expect(record().jobs[0]?.place).toBeUndefined();

		writeFileSync(join(dir, "cached.plan"), "cached\n");
		queue.keep({ ...ROOMY, vms: MOST_VMS }, NOW + 5_000, () => undefined);
		expect(
			queue.hasTurn("cached"),
			"a job whose plan found a build has its turn",
		).toBe(true);
		expect(record().jobs[0]).toMatchObject({ kind: "build" });
	});

	it("gives a quest put first its turn first, and says so", () => {
		const queue = folder();
		queue.ask(job("older", { since: new Date(NOW - 60_000).toISOString() }));
		queue.ask(job("lab", { quest: "QEST-LAB" }));
		writeFileSync(join(dir, QUEUE_FIRST_FILE), '["QEST-LAB"]\n');
		shellSays("older", 300);
		shellSays("lab", 301);

		queue.keep({ ...ROOMY, availableGib: 5 }, NOW, () => undefined);

		expect(queue.hasTurn("lab"), "the quest put first has its turn").toBe(true);
		expect(
			queue.hasTurn("older"),
			"the older job waits behind the quest put first",
		).toBe(false);
		expect(record().jobs.find((one) => one.id === "lab")).toMatchObject({
			quest: "QEST-LAB",
			first: true,
		});
	});

	it("says which of its pressure limits the machine is past, so a full queue reads apart", () => {
		const queue = folder();
		queue.ask(job("waits"));

		queue.keep(
			{
				...ROOMY,
				memoryPressure: MOST_MEMORY_PRESSURE,
				cpuPressure: MOST_CPU_PRESSURE_BESIDE_VMS,
			},
			NOW,
			() => undefined,
		);
		expect(record().machine.over).toEqual(["memory", "cpu"]);

		queue.keep(
			{ ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_BESIDE_VMS - 1 },
			NOW + 60_000,
			() => undefined,
		);
		expect(record().machine.over).toEqual([]);
	});

	// The lane holds one because a keep marks the job it turns started
	// before anything reads the queue again.
	it("gives one heavy job the lane while memory is pressed, and the next keep none", () => {
		const queue = folder();
		queue.ask(job("first", { since: new Date(NOW - 2_000).toISOString() }));
		queue.ask(job("second"));
		shellSays("first", 200);
		shellSays("second", 201);
		const moving = {
			...ROOMY,
			memoryPressure: MOST_MEMORY_PRESSURE,
			memoryFullMinute: MOST_MEMORY_STALL_FOR_ONE - 1,
			floorsPressure: 0,
		};

		queue.keep(moving, NOW, () => undefined);
		queue.keep(moving, NOW + SPREAD_MS + 1, () => undefined);

		expect(queue.hasTurn("first"), "the first has the lane").toBe(true);
		expect(queue.hasTurn("second"), "the second waits for it").toBe(false);
		expect(record().jobs.find((one) => one.id === "second")?.waitingOn).toBe(
			"memory",
		);
		expect(record().room).toEqual({ vms: 0, builds: 0 });
	});

	it("gives the first job its turn and shows the queue whole", () => {
		const queue = folder();
		queue.ask(job("first", { kind: "vm-test" }));
		queue.ask(job("second"));
		shellSays("first", 200);
		queue.keep(ROOMY, NOW, (one) =>
			one.kind === "vm-test" ? "/timed" : undefined,
		);
		expect(queue.hasTurn("first"), "the first job has its turn").toBe(true);
		expect(readFileSync(join(dir, "first.turn"), "utf8")).toBe("/timed");
		expect(
			queue.hasTurn("second"),
			"the second job waits while the first VM grows",
		).toBe(false);
		const shown = record();
		expect(shown.heartbeat).toBe(NOW / 1000);
		expect(shown.machine).toEqual({
			cores: 16,
			availableGib: 40,
			pressure: ROOMY.pressure,
			vms: 0,
			over: [],
		});
		// The VM started holds 6 GiB while it grows, so the build waits, and
		// no other VM starts until it settles.
		expect(shown.room).toEqual({ vms: 0, builds: 0 });
		expect(readFileSync(join(dir, "room"), "utf8")).toBe("");
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
				waitingOn: "order",
			},
		]);
	});

	it("names what each job builds, from its processes while it runs", () => {
		// Y2YBTS's launcher can't read a name from a loop's `what`, so a
		// running job's is read from its processes, where it is expanded.
		const loop = "for c in a b; do nix build .#checks.x86_64-linux.$c; done";
		const queue = queueFolder(dir, {
			isRunning: (pid) => running.has(pid),
			cgroupOf: (pid) => `/work-${pid}.scope`,
			commandsIn: (cgroup) =>
				cgroup === "/work-200.scope"
					? [`bash -c ${loop}`, "nix build .#checks.x86_64-linux.b"]
					: [],
		});
		queue.ask(job("loop", { what: loop }));
		queue.ask(
			job("named", { what: "nix build .#checks.x86_64-linux.formatting" }),
		);
		shellSays("loop", 200);
		queue.keep(ROOMY, NOW, () => undefined);
		const [loopJob, namedJob] = record().jobs;
		expect(loopJob).toMatchObject({ id: "loop", state: "running", name: "b" });
		expect(namedJob).toMatchObject({
			id: "named",
			state: "waiting",
			name: "formatting",
			waitingOn: "order",
		});
	});

	it("gives the turn to work a session waits on, as the mesh tells it", () => {
		const untell = tellAwaited(() => new Set(["session-b"]));
		try {
			const queue = folder();
			queue.ask(job("older", { since: new Date(NOW - 9_000).toISOString() }));
			queue.ask(job("waited", { owner: { session: "session-b", pid: 100 } }));
			queue.ask(
				job("after", {
					owner: { session: "session-b", pid: 100 },
					since: new Date(NOW - 500).toISOString(),
				}),
			);
			queue.keep(ROOMY, NOW, () => undefined);
			expect(
				queue.hasTurn("waited"),
				"the job a session waits on has its turn",
			).toBe(true);
			expect(
				queue.hasTurn("older"),
				"the older job nobody waits on gives way",
			).toBe(false);
			const waiting = record().jobs.filter((one) => one.state === "waiting");
			expect(
				waiting.map((one) => [one.id, one.place, one.awaited ?? false]),
			).toEqual([
				["after", 1, true],
				["older", 2, false],
			]);
		} finally {
			untell();
		}
	});

	it("gives turns by the rules it is kept with", () => {
		const ran = new Date(NOW - 120_000).toISOString();
		const ask = (queue: ReturnType<typeof folder>) => {
			queue.ask(job("check", { kind: "vm-check", started: ran }));
			queue.ask(job("build"));
			shellSays("check", 601);
			shellSays("build", 602);
		};
		const held = folder();
		ask(held);
		held.keep(
			{ ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_BESIDE_VMS },
			NOW,
			() => undefined,
		);
		expect(
			held.hasTurn("build"),
			"a build waits beside a VM check while the CPU is busy",
		).toBe(false);
		held.keep(ROOMY, NOW, () => undefined);
		expect(
			held.hasTurn("build"),
			"a build has its turn beside a VM check once the CPU is free",
		).toBe(true);
		const capped = join(dir, "build.capped");
		expect(
			existsSync(capped),
			`${capped} holds the build beside the check`,
		).toBe(true);
		expect(readFileSync(join(dir, "capped.conf"), "utf8")).toBe(
			"max-jobs = 2\ncores = 4\n",
		);
		expect(record().jobs.find((one) => one.id === "build")).toMatchObject({
			capped: true,
		});
		const free = queueFolder(
			dir,
			{ isRunning: (pid) => running.has(pid), cgroupOf: () => undefined },
			() => ({ buildsWaitForVmChecks: false }),
		);
		expect(readFileSync(join(dir, "build.capped"), "utf8")).toBe(
			"max-jobs = 2\ncores = 4\n",
		);
		free.ask(job("other"));
		shellSays("other", 603);
		free.keep(ROOMY, NOW + 3_000, () => undefined);
		expect(
			free.hasTurn("other"),
			"a keeper whose rules let builds run beside checks gives other its turn",
		).toBe(true);
		const otherCapped = join(dir, "other.capped");
		expect(
			existsSync(otherCapped),
			`${otherCapped} is not written by rules that do not hold builds`,
		).toBe(false);
		running.delete(602);
		free.keep(ROOMY, NOW + 6_000, () => undefined);
		expect(
			existsSync(capped),
			`${capped} goes once the build's shell has ended`,
		).toBe(false);
		// Quick work has a turn of its own beside the check, held tighter,
		// however busy the CPU is.
		held.ask(job("quick", { quick: true }));
		shellSays("quick", 604);
		held.keep(
			{ ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_BESIDE_VMS },
			NOW + 9_000,
			() => undefined,
		);
		expect(
			held.hasTurn("quick"),
			"quick work has its turn beside the check however busy the CPU is",
		).toBe(true);
		expect(readFileSync(join(dir, "quick.capped"), "utf8")).toBe(
			"max-jobs = 1\ncores = 2\n",
		);
		expect(record().jobs.find((one) => one.id === "quick")).toMatchObject({
			quick: true,
		});
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
		const finished = join(dir, "finished.pid");
		const unsaid = join(dir, "unsaid.job");
		expect(
			existsSync(finished),
			`${finished} goes with the job whose shell ended`,
		).toBe(false);
		expect(
			existsSync(unsaid),
			`${unsaid} goes with the job whose shell never said its pid`,
		).toBe(false);
	});

	it("gives up a job asked in an earlier boot, though its pid names a running process", () => {
		// A Mac's queue folder outlasts a reboot, and its pids come back.
		let boot = "boot-1";
		const queue = queueFolder(dir, {
			...processes,
			bootToken: () => boot,
			bootedAt: () => NOW - 60_000,
		});
		// Dated after the boot by its clock, it is still told by its token.
		queue.ask(job("before", { since: new Date(NOW - 30_000).toISOString() }));
		shellSays("before", 100);
		boot = "boot-2";
		queue.ask(job("after", { since: new Date(NOW - 30_000).toISOString() }));
		shellSays("after", 100);
		queue.keep(TIGHT, NOW, () => undefined);
		expect(record().jobs.map((one) => one.id)).toEqual(["after"]);
	});

	it("keeps a job asked in this boot, though its clock dates it before the boot", () => {
		// A clock stepped forward moves a boot worked out from uptime past
		// jobs still running, so the boot is told by its token, not a time:
		// dated an hour past the slack before it, which the time's rule
		// would give up.
		const booted = NOW - 60_000;
		const queue = queueFolder(dir, {
			...processes,
			bootToken: () => "boot-1",
			bootedAt: () => booted,
		});
		queue.ask(
			job("stepped", {
				since: new Date(
					booted - UNSTAMPED_BOOT_SLACK_MS - 3_600_000,
				).toISOString(),
			}),
		);
		shellSays("stepped", 100);
		queue.keep(TIGHT, NOW, () => undefined);
		expect(record().jobs.map((one) => one.id)).toEqual(["stepped"]);
	});

	// A job asked by older code, or where the machine couldn't say its
	// boot, has no token; judged by its pid alone, a pid the reboot gave
	// another process held its place for good (PV3TE0's F6).
	describe("with no boot token to tell a job by", () => {
		const booted = NOW - 60_000;
		const beforeBoot = (ms: number) => new Date(booted - ms).toISOString();

		it("gives up a job begun well before the boot, though its pid names a running process", () => {
			let boot: string | undefined;
			const queue = queueFolder(dir, {
				...processes,
				bootToken: () => boot,
				bootedAt: () => booted,
			});
			queue.ask(
				job("unstamped", {
					since: beforeBoot(UNSTAMPED_BOOT_SLACK_MS + 60_000),
				}),
			);
			shellSays("unstamped", 100);
			boot = "boot-2";
			queue.keep(TIGHT, NOW, () => undefined);
			expect(record().jobs).toEqual([]);
		});

		it("keeps a job begun within the slack before the boot, for a clock stepped forward a little", () => {
			let boot: string | undefined;
			const queue = queueFolder(dir, {
				...processes,
				bootToken: () => boot,
				bootedAt: () => booted,
			});
			queue.ask(
				job("unstamped", {
					since: beforeBoot(UNSTAMPED_BOOT_SLACK_MS - 60_000),
				}),
			);
			shellSays("unstamped", 100);
			boot = "boot-2";
			queue.keep(TIGHT, NOW, () => undefined);
			expect(record().jobs.map((one) => one.id)).toEqual(["unstamped"]);
		});

		it("judges a job by its pid alone where the keeper can tell no boot at all", () => {
			const queue = queueFolder(dir, processes);
			queue.ask(
				job("unstamped", { since: new Date(NOW - 86_400_000).toISOString() }),
			);
			shellSays("unstamped", 100);
			queue.keep(TIGHT, NOW, () => undefined);
			expect(record().jobs.map((one) => one.id)).toEqual(["unstamped"]);
		});
	});

	// A job stamped with its boot's token, kept by a session whose own
	// read missed, as sysctl can under load; it is read again within half
	// a minute.
	describe("while the keeper can't read its own boot token", () => {
		const booted = NOW - 60_000;
		const beforeBoot = (ms: number) => new Date(booted - ms).toISOString();

		// PV3TE0's round 2 (F12, F16): judged by the clock meanwhile, a job
		// running since the boot was given up, which can't be taken back.
		it("keeps a stamped job, however long before the boot it is dated", () => {
			let boot: string | undefined = "boot-1";
			const queue = queueFolder(dir, {
				...processes,
				bootToken: () => boot,
				bootedAt: () => booted,
			});
			queue.ask(job("since", { since: new Date(NOW - 30_000).toISOString() }));
			shellSays("since", 100);
			queue.ask(
				job("long-before", {
					since: beforeBoot(UNSTAMPED_BOOT_SLACK_MS + 60_000),
				}),
			);
			shellSays("long-before", 100);
			boot = undefined;
			queue.keep(TIGHT, NOW, () => undefined);
			// Sorted, since the record lists jobs as the folder does, which
			// ext4 orders by hash and APFS by name.
			expect(
				record()
					.jobs.map((one) => one.id)
					.sort(),
			).toEqual(["long-before", "since"]);
		});

		// PV3TE0's round 3 (F3): a keeper that kept its first miss would
		// hold every earlier boot's job for the life of its session.
		it("gives up an earlier boot's job once its token reads again", () => {
			let boot: string | undefined = "boot-0";
			const queue = queueFolder(dir, {
				...processes,
				bootToken: () => boot,
				bootedAt: () => booted,
			});
			queue.ask(job("earlier", { since: beforeBoot(60_000) }));
			shellSays("earlier", 100);
			boot = undefined;
			queue.keep(TIGHT, NOW, () => undefined);
			expect(
				record().jobs.map((one) => one.id),
				"kept while it can't tell",
			).toEqual(["earlier"]);

			boot = "boot-1";
			queue.keep(TIGHT, NOW + 1_000, () => undefined);
			expect(record().jobs, "given up once it can").toEqual([]);
		});
	});

	it("clears what a job left behind once its .job is gone", () => {
		// A session on older code dropped a job without the files it did not
		// know, so a `.began` stayed in the folder for every job it ended.
		// A job's .job is written before its shell is given the command, so
		// a file without one is left over; a minute's grace covers a clock
		// that disagrees.
		mkdirSync(dir, { recursive: true });
		const leftover = (name: string, ageMs: number) => {
			const file = join(dir, name);
			writeFileSync(file, "");
			const at = (NOW - ageMs) / 1000;
			utimesSync(file, at, at);
			return file;
		};
		const queue = folder();
		queue.ask(job("kept"));
		const keptBegan = leftover("kept.began", 10 * 60_000);
		const old = [
			leftover("gone.began", 10 * 60_000),
			leftover("gone.pid", 10 * 60_000),
			leftover("gone.end", 10 * 60_000),
		];
		const fresh = leftover("new.began", 1_000);
		const other = leftover("notes.txt", 10 * 60_000);

		queue.keep(ROOMY, NOW, () => undefined);

		for (const file of old)
			expect(
				existsSync(file),
				`${file}, left by a job long gone, is cleared`,
			).toBe(false);
		expect(
			existsSync(keptBegan),
			`${keptBegan}, of a job still queued, stays`,
		).toBe(true);
		expect(
			existsSync(fresh),
			`${fresh}, younger than a minute's grace, stays`,
		).toBe(true);
		expect(existsSync(other), `${other}, no job's file, stays`).toBe(true);
		const shown = join(dir, "queue.json");
		expect(existsSync(shown), `${shown} stays`).toBe(true);
	});

	it("leaves the queue to a session keeping it, until its lock is stale", () => {
		const queue = folder();
		queue.ask(job("first", { since: new Date().toISOString() }));
		const lock = join(dir, "locks", "queue");
		mkdirSync(lock, { recursive: true });
		queue.keep(ROOMY, Date.now(), () => undefined);
		expect(
			queue.hasTurn("first"),
			"no turn is given while another session holds a fresh lock",
		).toBe(false);
		const old = (Date.now() - 11_000) / 1000;
		utimesSync(lock, old, old);
		queue.keep(ROOMY, Date.now(), () => undefined);
		expect(
			queue.hasTurn("first"),
			"the turn is given once the lock is stale",
		).toBe(true);
		expect(existsSync(lock), `the stale lock ${lock} is taken away`).toBe(
			false,
		);
	});

	it("reads the machine only when it keeps the queue", () => {
		// Every session keeps the queue every two seconds, and a reading
		// walks every process on the machine: 1,821 of them under 88 pi
		// sessions on 4 November. Only the one holding the lock uses it.
		const queue = folder();
		queue.ask(job("first", { since: new Date().toISOString() }));
		const lock = join(dir, "locks", "queue");
		mkdirSync(lock, { recursive: true });
		let readings = 0;
		const room = () => {
			readings += 1;
			return ROOMY;
		};
		queue.keep(room, Date.now(), () => undefined);
		expect(readings).toBe(0);
		rmSync(lock, { recursive: true });
		queue.keep(room, Date.now(), () => undefined);
		expect(readings).toBe(1);
		expect(
			queue.hasTurn("first"),
			"the session holding the lock gives first its turn",
		).toBe(true);
	});

	it("counts each minute a job waited with its memory free, once", () => {
		const queue = folder();
		// The most VMs run, so one more waits on the limit with its memory free.
		const ran = new Date(NOW - 120_000).toISOString();
		for (let at = 0; at < MOST_VMS; at += 1) {
			queue.ask(job(`vm${at}`, { kind: "vm-check", started: ran }));
			shellSays(`vm${at}`, 410 + at);
		}
		queue.ask(job("held", { kind: "vm-test" }));
		shellSays("held", 403);
		// Their qemu runs here, as the machine's count shows.
		const running = { ...ROOMY, vms: MOST_VMS };
		queue.keep(running, NOW, () => undefined);
		expect(record().wasted.today).toBe(1);
		queue.keep(running, NOW + 10_000, () => undefined);
		expect(record().wasted.today).toBe(1);
		queue.keep(running, NOW + 60_000, () => undefined);
		expect(record().wasted.today).toBe(2);
		queue.keep(TIGHT, NOW + 120_000, () => undefined);
		expect(record().wasted.today).toBe(2);
		queue.keep(running, Date.parse("2026-10-23T00:00:10Z"), () => undefined);
		expect(record().wasted).toEqual({
			today: 1,
			day: "2026-10-23",
			minute: "2026-10-23T00:00",
		});
	});
});
