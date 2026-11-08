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
import { tellAwaited } from "../../../../lib/internal/priority/awaited.ts";
import {
	HEARTBEAT_MS,
	isKept,
	KEPT_FOR_MS,
	machineQueueDir,
	PID_MS,
	QUEUE_FIRST_FILE,
	type QueueRecord,
	queueFolder,
	readQueue,
} from "../../../../lib/internal/priority/folder.ts";
import { NEWER_KEEPER_MS } from "../../../../lib/internal/priority/keeper.ts";
import {
	FAILURES_TO_LOWER_VMS,
	keepOutcome,
	NOTHING_BESIDE,
	outcomeOf,
} from "../../../../lib/internal/priority/outcome.ts";
import {
	type Job,
	MOST_CPU_PRESSURE_BESIDE_VMS,
	MOST_MEMORY_PRESSURE,
	MOST_VMS,
} from "../../../../lib/internal/priority/queue.ts";
import type { Reading } from "../../../../lib/internal/priority/room.ts";

const NOW = Date.parse("2026-10-22T16:00:30Z");
const ROOMY: Reading = {
	availableGib: 40,
	memoryPressure: 0,
	vms: 0,
	cpuPressure: 1,
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

const processes = {
	isRunning: (pid: number) => running.has(pid),
	cgroupOf: (pid: number) => `/jobs.slice/jobs.service#${pid}`,
};

const folder = () => queueFolder(dir, processes);

function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		kind: "build",
		what: "cargo build",
		owner: { session: "session-a", pid: 100 },
		since: new Date(NOW - 1_000).toISOString(),
		cappable: true,
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

	it("is kept while queue.json is younger than two minutes", () => {
		expect(machineQueueDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
			"/run/user/1000/jobs",
		);
		expect(machineQueueDir({})).toBeUndefined();
		expect(isKept(dir), "a folder with no queue.json is not kept").toBe(false);
		folder().keep(ROOMY, NOW, () => undefined);
		const written = statSync(join(dir, "queue.json")).mtimeMs;
		expect(
			isKept(dir, written + 119_999),
			"a queue.json just under two minutes old is kept",
		).toBe(true);
		expect(
			isKept(dir, written + 120_000),
			"a queue.json two minutes old is not kept",
		).toBe(false);
	});

	it("is read back only while it is kept, and only in a shape it knows", () => {
		expect(readQueue(dir)).toBeUndefined();
		const queue = folder();
		queue.ask(job("waiting"));
		queue.keep(ROOMY, NOW, () => undefined);
		const written = statSync(join(dir, "queue.json")).mtimeMs;

		expect(readQueue(dir, written)?.jobs.map(({ id }) => id)).toEqual([
			"waiting",
		]);
		// What nobody keeps says what ran before, not what runs now.
		expect(readQueue(dir, written + 120_000)).toBeUndefined();
		writeFileSync(join(dir, "queue.json"), '{"v":2,"jobs":[]}\n');
		expect(readQueue(dir)).toBeUndefined();
	});

	it("writes queue.json when it changes or its heartbeat is due", () => {
		const queue = folder();
		queue.ask(job("waiting"));
		shellSays("waiting", 501);
		queue.keep(TIGHT, NOW, () => undefined);
		const first = record().heartbeat;
		queue.keep(TIGHT, NOW + HEARTBEAT_MS - 1, () => undefined);
		expect(record().heartbeat).toBe(first);
		expect(
			queue.isDue(statSync(join(dir, "queue.json")).mtimeMs + 1),
			"no heartbeat is due a moment after queue.json was written",
		).toBe(false);
		queue.keep(TIGHT, NOW + HEARTBEAT_MS, () => undefined);
		expect(record().heartbeat).toBe(first + HEARTBEAT_MS / 1000);
		queue.ask(job("another"));
		shellSays("another", 502);
		queue.keep(TIGHT, NOW + HEARTBEAT_MS + 1_000, () => undefined);
		expect(record().jobs).toHaveLength(2);
		expect(queue.hasJobs(), "a queue holding two jobs has jobs").toBe(true);
	});

	it("leaves pressure alone to the heartbeat, whichever session keeps it", () => {
		// Under ten VMs on 30 October it was replaced 123 times in 10 s,
		// each costing the shell about 20 wakeups, for pressure alone.
		folder().ask(job("waiting"));
		shellSays("waiting", 501);
		folder().keep(TIGHT, NOW, () => undefined);
		const first = record().heartbeat;
		const pressed = {
			...TIGHT,
			availableGib: TIGHT.availableGib + 0.3,
			pressure: { ...TIGHT.pressure, cpu: TIGHT.pressure.cpu + 3 },
		};
		folder().keep(pressed, NOW + 1_000, () => undefined);
		expect(record().heartbeat).toBe(first);
		folder().keep(pressed, NOW + HEARTBEAT_MS, () => undefined);
		expect(record().machine.pressure.cpu).toBe(TIGHT.pressure.cpu + 3);
	});

	it("answers the fetches of main waiting on one that moved origin/main, for a minute after", () => {
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

	it("leaves the fetches of main waiting to their own turns when the one running moved nothing", () => {
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
	});

	it("keeps how each job ended and what ran beside it", () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		// The check passed before, with no capped build beside it.
		const before = new Date(NOW - 600_000).toISOString();
		keepOutcome(
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

	it("keeps what each job waited on, writing its file only as the reason changes", () => {
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

	it("records the most memory a job's own commands held, from its scope", () => {
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
				memoryPeakOf: (cgroup) => peaks.get(cgroup),
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
		const kept = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const driver = kept.find((outcome) => outcome.id === "driver");
		const unread = kept.find((outcome) => outcome.id === "unread");
		expect(driver).toMatchObject({ ownPeakBytes: 5 * GIB });
		expect(driver).not.toHaveProperty("buildsPeakBytes");
		// A scope whose peak can't be read says nothing, rather than nought.
		expect(unread).not.toHaveProperty("ownPeakBytes");
	});

	it("says how long a VM job held its slot before a VM of its own ran", () => {
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

		const kept = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const of = (id: string) => kept.find((outcome) => outcome.id === id);
		expect(of("check")).toMatchObject({ vmAfterS: 90 });
		expect(of("test")).toMatchObject({ vmAfterS: 90 });
		expect(of("none")).not.toHaveProperty("vmAfterS");
	});

	it("learns from a job's builds whether it runs a check with deadlines, and how much memory they held", () => {
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
		keepOutcome(
			file,
			outcomeOf(job("gave-up", { what: "nix flake check" }), NOW + 7_000, 0),
		);
		expect(queue.kindFor("build", "nix flake check")).toBe("vm-check");
		// Its latest run built no check with deadlines, all cached, so it is a
		// build again.
		keepOutcome(
			file,
			outcomeOf(
				job("cached", { what: "nix flake check", started: ran }),
				NOW + 8_000,
				0,
			),
		);
		expect(queue.kindFor("build", "nix flake check")).toBe("build");
	});

	it("runs fewer VMs while the outcomes say the most was too many", () => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const check = (id: string, exit: number, vms: number) => ({
			...outcomeOf(
				job(id, { kind: "vm-check", started: new Date(NOW).toISOString() }),
				NOW + 60_000,
				exit,
			),
			beside: { ...NOTHING_BESIDE, vms },
		});
		keepOutcome(file, check("passed", 0, MOST_VMS - 1));
		for (let at = 0; at < FAILURES_TO_LOWER_VMS; at += 1) {
			keepOutcome(file, check(`failed${at}`, 1, MOST_VMS));
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
