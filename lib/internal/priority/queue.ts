/**
 * The machine's queue: heavy work takes turns by the room it needs.
 *
 * Every pi session on the machine shares one queue, kept as files in
 * the account's runtime directory (see folder.ts), with no daemon and
 * nobody in charge: whichever session looks next starts the next job.
 * An agent learns nothing new. Its bash call runs as it always did; the
 * harness reads what kind of work the command is from one map, so no
 * agent names its own place, and the command's shell waits for its
 * turn before it starts. pi itself never waits, only the shell does.
 *
 * What a turn is decided by:
 *
 * - **Memory**, the one hard limit: CPU is shared by weight, so an idle
 *   build only takes what nobody else wants, but memory past what the
 *   machine has is what systemd-oomd ends work for. A job starts when
 *   the memory left past the floors core.nix keeps for Joel's programs
 *   covers what its kind needs, and pressure is under a set point.
 * - **Kinds held to a number at once**: VMs, whose tests time out when
 *   they share the CPU with too much else. The VMs running are counted
 *   on the machine as well as in the queue, since a command can pick
 *   its check from a variable the queue can't read, and a session on
 *   older code runs its VMs outside the queue.
 * - **Order**: timed work before bulk, quick work before the rest of
 *   bulk, then work another session waits on (see awaited.ts), then the
 *   oldest first. A job its limit holds back lets the next one past; a
 *   job memory holds back holds everyone behind it but quick work, one
 *   quick job at a time, so a big job is never starved by small ones
 *   slipping in and a check of seconds never waits on it.
 * - **One at a time, a little apart**: memory is read a moment after
 *   it is taken, and everyone reacting at once to one reading is what
 *   makes a group overshoot and swing back, so turns are given out one
 *   at a time, a few seconds apart, with what was just started counted
 *   as taken until it has had time to grow.
 *
 * The room left over is said too ({@link roomLeft}): the queue only
 * fills the machine with work somebody starts, and most of the idle
 * minutes measured on 22 October (35 of 43 under half busy) had no VM
 * running at all, while agents ran their tests one after another.
 */

import { noun } from "../../ui/count.ts";
import { NOBODY } from "./awaited.ts";
import type { Beside } from "./outcome.ts";

/** What a command does, as the harness reads it. */
export type Kind = "vm-test" | "vm-check" | "benchmark" | "build";

/**
 * How a kind is run: timed work's result depends on its timing, so it
 * runs at a weight of its own; bulk takes whatever is left.
 */
export type Class = "timed" | "bulk";

export const CLASS_OF: Readonly<Record<Kind, Class>> = {
	// A VM test run from its driver, in the session's own cgroups.
	"vm-test": "timed",
	// A VM test run by the Nix daemon, as `nix build` of a check does: it
	// runs in build.slice whatever the queue says, so it is bulk here,
	// but it is a VM all the same and counts against the VMs at once.
	"vm-check": "bulk",
	benchmark: "timed",
	build: "bulk",
};

/**
 * The memory each kind is held to need, in GiB. 2HN63P's VM tests take
 * 2 to 6 GiB each, so a VM is given the top of that. A build's and a
 * benchmark's are starting values, not yet measured.
 */
export const NEEDS_GIB: Readonly<Record<Kind, number>> = {
	"vm-test": 6,
	"vm-check": 6,
	benchmark: 2,
	build: 4,
};

/**
 * What a whole flake's check holds, in GiB, whatever its kind: `nix flake
 * check` evaluates every output before it builds one, and keeps that heap
 * until the last build ends. A core.nix check's evaluator held 17.1 GiB
 * (P9R1KI's measurement) and 17.8 to 20.2 GiB in four that ran at once on
 * 23 October, against the 4 a build is held to: the queue let in about
 * 80 GiB it counted as 16, and the rest went to swap.
 */
export const EVALUATION_GIB = 20;

/**
 * core.nix's changed-checks, run as a command rather than named as a
 * file: it evaluates every check twice, at the base and in the tree,
 * then builds what moved, VM tests too unless told `--no-vm`. Run from
 * a `bin` folder too, as `$out/bin/changed-checks` runs a build of it,
 * but never a file or folder named after it, such as its crate's.
 */
const CHANGED_CHECKS = /(?:(?<![\w./-])|(?<=\/bin\/))changed-checks(?![\w./-])/;

/**
 * What evaluating every check's derivation at once holds, in GiB: it
 * reached 24 GB on optimus inside changed-checks (2HN63P's run, 7SU7HB's
 * measurement), and a bare `nix eval` of every check about the same
 * (Y9XISP's), and 2HN63P's evaluation of a commit's checks held 22 GiB on
 * 24 October. Two ran with no turn that day at about 20 each, beside a
 * flake check given one, which filled swap.
 */
export const EVERY_CHECK_GIB = 24;

/**
 * What changed-checks holds, in GiB: since core #465 it evaluates checks
 * 40 at a time, so its peak is one chunk's, not every check's. Its own
 * scope peaked at 11.7 and 12.5 GiB in the two runs recorded on 24
 * October, and a chunk of 40 VM tests, the heaviest chunk it can meet,
 * held 13.8 GiB evaluated alone (40 other checks held 4.9). The last tree
 * still running the tool from before #465 was pruned that day.
 */
export const CHANGED_CHECKS_GIB = 16;

/**
 * cargo up to its subcommand, past a `+toolchain` and flags such as
 * `--locked`: `cargo +nightly build` and `cargo --locked build` ran with
 * no turn, as did the short aliases, `cargo b`, `cargo t` and `cargo c`.
 */
const CARGO = String.raw`\bcargo(?:\s+\+\S+)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+`;

/** nix-fast-build, which evaluates every check, then builds them. */
const NIX_FAST_BUILD = /(?<![\w./-])nix-fast-build(?![\w.-])/;

/** An evaluation of a flake's every check, for one system or all. */
const EVERY_CHECK =
	/\bnix(?:\s+--?\S+)*\s+eval\b[^\n]*#checks(?:\.[\w-]+)?(?![\w.-])/;

/**
 * A command that evaluates a whole flake's checks: `nix flake check`,
 * changed-checks, and an evaluation of every check.
 */
const WHOLE_FLAKE = new RegExp(
	[
		/\bnix(?:\s+--?\S+)*\s+flake\s+check\b/,
		CHANGED_CHECKS,
		EVERY_CHECK,
		NIX_FAST_BUILD,
	]
		.map((pattern) => pattern.source)
		.join("|"),
);

/**
 * The memory one job is held to need, in GiB: what it was judged to need
 * when it asked, from its whole step, or else from what it does, which a
 * job an older harness asked for carries alone.
 */
export function needsGibOf(
	job: Pick<Job, "kind" | "what"> & Pick<Partial<Job>, "needsGib">,
): number {
	if (job.needsGib !== undefined) return job.needsGib;
	const kind = NEEDS_GIB[job.kind];
	if (CHANGED_CHECKS.test(job.what)) return Math.max(kind, CHANGED_CHECKS_GIB);
	if (EVERY_CHECK.test(job.what)) return Math.max(kind, EVERY_CHECK_GIB);
	return WHOLE_FLAKE.test(job.what) ? Math.max(kind, EVALUATION_GIB) : kind;
}

/**
 * How many VMs run at once. 2HN63P's run 1 to 4 vCPUs each and kvm
 * takes several together; they ran one at a time across the machine
 * only because their timeouts flaked beside each other and big builds.
 *
 * Two held work back with the CPU free: after the 22 October reboot it
 * was under half busy in 35 of 47 minutes, a VM ran in 30 of those, and
 * three VM checks waited 98 to 551 s at the limit. Of the 22 daemon VM
 * checks with an exit by then, 21 passed, 18 with builds beside them and
 * two of those with three VMs running at CPU pressure up to 50; the one
 * that failed ended in 11 s, no timeout. Since core #381, too, daemon-run
 * qemu runs at nice -10, ahead of the builds beside it. So three ran at
 * once.
 *
 * Three held work back too. On 24 October at 17:30 ten VM checks had
 * waited up to 57 minutes with 25 GiB free and two qemu on 1.4 of 16
 * cores. Of 623 VM runs from 22 October, those with 0 to 2 VMs beside
 * them failed 4.7% of the time, 213 runs; with 3 to 5, 2.5%, 319 runs;
 * with 6 or more beside, 2.2%, 91 runs; nor did failures rise with CPU
 * pressure, 20 of 623 at none to past 60. The counts are the machine's
 * qemu, so a test with two machines counts twice, and a limit of three
 * jobs has had eight qemu beside it. So four ran at once.
 *
 * Four held work back as well. From 22:00 on 28 October VM work waited
 * in 268 of 269 minutes, all four slots full in 177 of them, and VM
 * checks waited a median 35 minutes. Run beside more VMs, the same work
 * took no longer: of 191 runs of 26 commands run three times or more,
 * each against its own median took x0.90 with 3 to 4 qemu beside it,
 * x1.08 with 5 to 6, x1.01 with 7 to 9 and x1.00 with 10 or more, and 6
 * of 241 failed. CPU pressure is what slowed them (x1.52 past 75), which
 * the cap on builds beside VM checks already answers. So six run at
 * once, the two past {@link VMS_WHATEVER_FLOORS_FEEL} only while the
 * person's own programs wait on no memory, and {@link FEWER_VMS} while
 * the outcomes say six is too many (see vmsFor in outcome.ts).
 */
export const MOST_VMS = 6;

/**
 * How many VMs run at once for a day while they fail more often at
 * {@link MOST_VMS} than with fewer.
 */
export const FEWER_VMS = 5;

/**
 * How many VMs start whatever the person's own programs feel. Past it a
 * VM starts only while the programs a memory floor keeps, app.slice's
 * among them, stall on memory no more than {@link MOST_FLOORS_PRESSURE}:
 * their windows were paged out overnight on 28 October with 5 GiB of
 * app.slice in swap, and each VM more pages them deeper (5FWIUS). That
 * reads 0 until his programs wait, so it costs nothing until then.
 */
export const VMS_WHATEVER_FLOORS_FEEL = 4;

/** Memory pressure (avg10, percent) a floor's programs may feel beside VMs past the first few. */
export const MOST_FLOORS_PRESSURE = 1;

/**
 * How many VMs may run now: the rule's most, or no more than
 * {@link VMS_WHATEVER_FLOORS_FEEL} while the person's own programs wait
 * on memory. Where no floor is read, there is nobody's memory to guard.
 */
function vmsAllowed(room: Room, rules: Rules): number {
	const most = rules.mostVms ?? MOST_VMS;
	return room.floorsPressure !== undefined &&
		room.floorsPressure > MOST_FLOORS_PRESSURE
		? Math.min(most, VMS_WHATEVER_FLOORS_FEEL)
		: most;
}

/** Memory pressure (avg10, percent) past which no job starts. */
export const MOST_MEMORY_PRESSURE = 10;

/** How far apart two turns are given. */
export const SPREAD_MS = 3_000;

/** How long a started job's need counts as taken, while it grows. */
export const RAMP_MS = 60_000;

/** One piece of heavy work, waiting for its turn or running. */
export interface Job {
	readonly id: string;
	readonly kind: Kind;
	/** The step that does the heavy work, as one line. */
	readonly what: string;
	/**
	 * The memory it was judged to need as it asked, in GiB, from its whole
	 * step: `what` is cut short, and a long flake reference such as
	 * `git+file://$PWD?rev=<commit>` once cut off the `#checks` that said a
	 * job evaluates every check, holding it to a build's 4.
	 */
	readonly needsGib?: number;
	/** The pi session that started it, and pi's pid. */
	readonly owner: { readonly session: string; readonly pid: number };
	/** When it asked for its turn. */
	readonly since: string;
	/** When it was given its turn, once it has one. */
	readonly started?: string;
	/** Given its turn beside a VM check, with its Nix builds capped. */
	readonly capped?: boolean;
	/**
	 * Whether its shell caps its builds when told to. A shell an older
	 * harness started waits without reading the cap, so its build beside a
	 * VM check would run on every core; it waits for the check instead.
	 */
	readonly cappable?: boolean;
	/** The most that ran beside it at once, while it runs. */
	readonly beside?: Beside;
	/**
	 * A Nix build it asked for ran a VM or another check with deadlines,
	 * seen while it runs, so the next time it is asked for it waits as one.
	 */
	readonly ranTimed?: true;
	/**
	 * The most memory its Nix builds held at once, in bytes: up to, since
	 * it adds each build's own peak, and those need not have met.
	 */
	readonly buildsPeakBytes?: number;
	/**
	 * The most memory its own commands held, in bytes, from its shell's
	 * scope: the `nix` client's evaluation, cargo, or a VM test run from
	 * its driver, none of which is a Nix build's.
	 */
	readonly ownPeakBytes?: number;
	/**
	 * A build its last run, or failing one what it builds, says takes
	 * seconds (outcome.ts's `quickAfter`): it goes ahead of other bulk
	 * work, past a job held back, and has a turn of its own beside a VM
	 * check, at {@link QUICK_NIX}.
	 */
	readonly quick?: true;
	/**
	 * The quest its session had loaded as it asked, from the `PI_QUEST`
	 * its commands carry, so a quest marked `queue: first` goes ahead.
	 */
	readonly quest?: string;
	/**
	 * Its shell is asking Nix what it will build (plan.ts), so it has no
	 * place in line until the plan is read or plan.ts's `PLAN_MS` passes.
	 */
	readonly planning?: true;
	/** What its plan made it, or that the plan said nothing. */
	readonly planned?: "vm-check" | "build" | "failed";
	/** Why its plan said nothing, when it didn't. */
	readonly planFailed?: string;
}

/** What the machine has left, as the queue reads it. */
export interface Room {
	/** Memory available past the floors, in GiB. */
	readonly availableGib: number;
	/** Memory pressure, avg10, in percent. */
	readonly memoryPressure: number;
	/** VMs running on the machine, queued or not. */
	readonly vms: number;
	/** CPU pressure, avg10, in percent. */
	readonly cpuPressure: number;
	/**
	 * Memory pressure, avg10, in percent, the most any memory floor's
	 * programs feel: the person's own, as app.slice holds them. Nothing
	 * where no floor is read.
	 */
	readonly floorsPressure?: number;
}

const VMS: ReadonlySet<Kind> = new Set(["vm-test", "vm-check"]);

/** Whether a job holds a VM. */
export function isVm(job: Pick<Job, "kind">): boolean {
	return VMS.has(job.kind);
}

/**
 * The jobs waiting, in the order they get their turns: within each
 * class, those of the sessions `awaited` names first, then those of the
 * quests `first` names. Never ahead of its class, so only bulk work is
 * ever behind a build. A job still planning has no place yet.
 */
export function waitingInOrder(
	jobs: readonly Job[],
	awaited: ReadonlySet<string> = NOBODY,
	first: ReadonlySet<string> = NOBODY,
): Job[] {
	const waitedOn = (job: Job) => (awaited.has(job.owner.session) ? 0 : 1);
	const putFirst = (job: Job) =>
		job.quest !== undefined && first.has(job.quest) ? 0 : 1;
	return jobs
		.filter((job) => job.started === undefined && !job.planning)
		.sort(
			(one, other) =>
				rank(one) - rank(other) ||
				waitedOn(one) - waitedOn(other) ||
				putFirst(one) - putFirst(other) ||
				Date.parse(one.since) - Date.parse(other.since) ||
				one.id.localeCompare(other.id),
		);
}

const rank = (job: Job) =>
	CLASS_OF[job.kind] === "timed" ? 0 : isQuick(job) ? 1 : 2;

/**
 * Whether a job takes the quick turn: a build marked quick whose shell
 * reads its own cap, which a shell an older harness started can't.
 */
function isQuick(job: Job): boolean {
	return job.quick === true && job.kind === "build" && job.cappable === true;
}

/**
 * How the queue gives turns beyond memory, while the machine lacks the
 * timed slice.
 */
export interface Rules {
	/**
	 * Whether builds are held back while a VM check runs. The queue gates
	 * memory, not CPU, and a VM check is the daemon's, in build.slice, so
	 * a build started beside it shares its CPU: a kernel build beside a
	 * running camera subtest is what broke its timing. Holding every build
	 * cost more than it saved: at 13:47 on 22 October one check, on two
	 * thirds of one core, held five builds for up to 24 minutes while the
	 * CPU sat 72% idle. So {@link BUILDS_BESIDE_VMS} build at a time starts
	 * beside one while CPU pressure is under
	 * {@link MOST_CPU_PRESSURE_BESIDE_VMS}, and the rest wait. Pressure is
	 * read seconds late, and nothing slows a daemon build once it runs, so
	 * that build is capped as it starts (see {@link CAPPED_NIX}).
	 *
	 * A VM check still starts beside builds, but not past one waiting for
	 * its turn, so a build waits only for the checks already running:
	 * skipping it instead let a stream of 15-minute checks hold a 1-minute
	 * build at place 5 for as long as they kept coming. Off once VM tests
	 * run timed, from their drivers.
	 */
	readonly buildsWaitForVmChecks: boolean;
	/** How many VMs run at once, when not {@link MOST_VMS}. */
	readonly mostVms?: number;
}

/** How many builds run beside a VM check at once. */
export const BUILDS_BESIDE_VMS = 1;

/** CPU pressure (avg10, percent) past which no build starts beside one. */
export const MOST_CPU_PRESSURE_BESIDE_VMS = 10;

/** A pressure limit the queue holds work back at, by what presses. */
export type Pressed = "memory" | "cpu";

/**
 * The queue's pressure limits the machine is at or past now: `memory`
 * at {@link MOST_MEMORY_PRESSURE}, where no job starts, and `cpu` at
 * {@link MOST_CPU_PRESSURE_BESIDE_VMS}, where no build starts beside a
 * VM check. The queue's verdict rather than its numbers, so a reader
 * outside it, as mycelium's node is, never applies the rules again.
 */
export function pressedPast(
	room: Pick<Room, "memoryPressure" | "cpuPressure">,
): Pressed[] {
	return [
		...(room.memoryPressure >= MOST_MEMORY_PRESSURE ? ["memory" as const] : []),
		...(room.cpuPressure >= MOST_CPU_PRESSURE_BESIDE_VMS
			? ["cpu" as const]
			: []),
	];
}

/**
 * The Nix settings a build beside a VM check runs with: at most about 8
 * of the 16 cores, which leaves at least 8 for qemu. P9R1KI's estimate,
 * not a measurement: the one failure measured was an all-core kernel
 * build, at load about 30, beside vm-desktop-works. If a VM fails beside
 * a capped build, cores drop to 2. The daemon honours them because the
 * account is a trusted user.
 */
export const CAPPED_NIX = { maxJobs: 2, cores: 4 } as const;

/**
 * How many quick jobs run beside a VM check at once, beside the one
 * capped build, whatever the CPU pressure. From 24 October to 26 October,
 * 86 builds that then ran under a minute had waited over two: 69 of
 * them, 361 minutes, while a VM check ran, when only one build may start
 * beside it and only under {@link MOST_CPU_PRESSURE_BESIDE_VMS}, and the
 * pressure sat at 40 to 70. One at a time is also how many may pass a
 * job that is held back.
 */
export const QUICK_AT_ONCE = 1;

/**
 * The Nix settings a quick job beside a VM check runs with: one build
 * on two cores, an eighth of the machine, against the capped build's
 * eight. A text check needs one.
 */
export const QUICK_NIX = { maxJobs: 1, cores: 2 } as const;

export const RULES: Rules = { buildsWaitForVmChecks: true };

/**
 * The job to start now, if any: the first waiting in order that its
 * kind's limit and the memory left both let in. Nothing within
 * {@link SPREAD_MS} of the last turn given.
 */
export function nextTurn(
	jobs: readonly Job[],
	room: Room,
	now: number,
	rules: Rules = RULES,
	awaited: ReadonlySet<string> = NOBODY,
	first: ReadonlySet<string> = NOBODY,
): Job | undefined {
	const running = jobs.filter((job) => job.started !== undefined);
	const last = Math.max(
		-Infinity,
		...running.map((job) => Date.parse(job.started as string)),
	);
	if (now - last < SPREAD_MS) return undefined;
	if (room.memoryPressure >= MOST_MEMORY_PRESSURE) return undefined;
	const { growing, vms, builds, quick } = standing(jobs, room, now, rules);
	const fits = (job: Job) => room.availableGib - growing >= needsGibOf(job);
	const waiting = waitingInOrder(jobs, awaited, first);
	// Quick work passes older work, one job at a time: it ends in seconds,
	// so what it passes waits seconds longer, never starved by a stream.
	const passes = (job: Job) =>
		waiting.some(
			(other) =>
				!isQuick(other) && Date.parse(other.since) < Date.parse(job.since),
		);
	let held = false;
	for (const job of waiting) {
		if (isQuick(job)) {
			const queuedPast = passes(job) && quick.running >= QUICK_AT_ONCE;
			if (quick.left < 1 || queuedPast || !fits(job)) continue;
			return Number.isFinite(quick.left) ? { ...job, capped: true } : job;
		}
		if (held) continue;
		if (isVm(job) && vms >= vmsAllowed(room, rules)) continue;
		// Only bulk work is behind a build, and it all waits with it.
		const ruledOut =
			job.kind === "build" &&
			(builds < 1 || (Number.isFinite(builds) && !job.cappable));
		if (ruledOut || !fits(job)) {
			held = true;
			continue;
		}
		return job.kind === "build" && Number.isFinite(builds)
			? { ...job, capped: true }
			: job;
	}
	return undefined;
}

/**
 * Why a job waits: `memory`, the memory it needs isn't free; `vms`, the
 * VMs allowed at once are running; `behind`, a VM check runs and builds
 * beside one are at their limit; `order`, jobs ahead of it come first;
 * `planning`, its shell is asking Nix what it will build.
 */
export type WaitReason = "memory" | "vms" | "behind" | "order" | "planning";

/**
 * Why each waiting job waits, by its id, judged by {@link nextTurn}'s
 * own rules in its own order, so the two never disagree. A job that
 * would start is waiting on the order: it gets its turn when the queue
 * next gives one, or after the one ahead of it.
 */
export function waitReasons(
	jobs: readonly Job[],
	room: Room,
	now: number,
	rules: Rules = RULES,
	awaited: ReadonlySet<string> = NOBODY,
	first: ReadonlySet<string> = NOBODY,
): Map<string, WaitReason> {
	const reasons = new Map<string, WaitReason>();
	for (const job of jobs) {
		if (job.started === undefined && job.planning) {
			reasons.set(job.id, "planning");
		}
	}
	const waiting = waitingInOrder(jobs, awaited, first);
	if (room.memoryPressure >= MOST_MEMORY_PRESSURE) {
		for (const job of waiting) reasons.set(job.id, "memory");
		return reasons;
	}
	const { growing, vms, builds, quick } = standing(jobs, room, now, rules);
	const fits = (job: Job) => room.availableGib - growing >= needsGibOf(job);
	const passes = (job: Job) =>
		waiting.some(
			(other) =>
				!isQuick(other) && Date.parse(other.since) < Date.parse(job.since),
		);
	let held = false;
	let given = false;
	for (const job of waiting) {
		const reason = ((): WaitReason => {
			if (isQuick(job)) {
				if (quick.left < 1) return "behind";
				if (passes(job) && quick.running >= QUICK_AT_ONCE) return "order";
				if (!fits(job)) return "memory";
				given = true;
				return "order";
			}
			if (held || given) return "order";
			if (isVm(job) && vms >= vmsAllowed(room, rules)) return "vms";
			const ruledOut =
				job.kind === "build" &&
				(builds < 1 || (Number.isFinite(builds) && !job.cappable));
			if (ruledOut || !fits(job)) {
				held = true;
				return ruledOut ? "behind" : "memory";
			}
			given = true;
			return "order";
		})();
		reasons.set(job.id, reason);
	}
	return reasons;
}

/**
 * What running work holds: memory still growing, VMs, how many builds
 * may start beside a VM check (all of them, with none running), and how
 * many quick jobs run and may start.
 */
function standing(
	jobs: readonly Job[],
	room: Room,
	now: number,
	rules: Rules,
): {
	growing: number;
	vms: number;
	builds: number;
	quick: { running: number; left: number };
} {
	const running = jobs.filter((job) => job.started !== undefined);
	const growing = running
		.filter((job) => now - Date.parse(job.started as string) < RAMP_MS)
		.reduce((sum, job) => sum + needsGibOf(job), 0);
	// A VM just given its turn may not have started its qemu yet, and one
	// the machine shows may be outside the queue: the larger count holds.
	const vms = Math.max(running.filter(isVm).length, room.vms);
	const tests = running.filter((job) => job.kind === "vm-test").length;
	const checking =
		rules.buildsWaitForVmChecks &&
		(running.some((job) => job.kind === "vm-check") || room.vms > tests);
	const quickRunning = running.filter(isQuick).length;
	const beside = running.filter(
		(job) => job.kind === "build" && !isQuick(job),
	).length;
	const builds = !checking
		? Number.POSITIVE_INFINITY
		: room.cpuPressure < MOST_CPU_PRESSURE_BESIDE_VMS
			? Math.max(0, BUILDS_BESIDE_VMS - beside)
			: 0;
	const quick = {
		running: quickRunning,
		left: checking
			? Math.max(0, QUICK_AT_ONCE - quickRunning)
			: Number.POSITIVE_INFINITY,
	};
	return { growing, vms, builds, quick };
}

/** How many more VMs and builds could start now. */
export interface RoomLeft {
	readonly vms: number;
	readonly builds: number;
}

/**
 * How many more VMs and builds would get their turns now, beside what
 * runs and behind what waits: the room nobody is using.
 */
export function roomLeft(
	jobs: readonly Job[],
	room: Room,
	now: number,
	rules: Rules = RULES,
): RoomLeft {
	if (room.memoryPressure >= MOST_MEMORY_PRESSURE) return { vms: 0, builds: 0 };
	const { growing, vms, builds } = standing(jobs, room, now, rules);
	const waiting = waitingInOrder(jobs);
	const free =
		room.availableGib -
		growing -
		waiting.reduce((sum, job) => sum + needsGibOf(job), 0);
	const fits = (kind: Kind) => Math.max(0, Math.floor(free / NEEDS_GIB[kind]));
	const slots = Math.max(
		0,
		vmsAllowed(room, rules) - vms - waiting.filter(isVm).length,
	);
	// A build waiting is held by memory or the rule, and so is the next.
	const buildWaits = waiting.some((job) => job.kind === "build");
	return {
		vms: buildWaits && builds < 1 ? 0 : Math.min(fits("vm-test"), slots),
		builds: buildWaits ? 0 : Math.min(fits("build"), builds),
	};
}

/** The room left as words, such as "2 more VM tests and 8 more builds". */
export function roomSaid(left: RoomLeft): string {
	const more = (n: number, what: string) =>
		n > 0 ? `${n} more ${noun(n, what)}` : "";
	return [more(left.vms, "VM test"), more(left.builds, "build")]
		.filter((part) => part !== "")
		.join(" and ");
}

/**
 * Whether a job is waiting though the memory it needs is free: held by
 * a limit, not by room. A minute this holds is a wasted minute, the
 * number the queue's limits are tuned to bring to nothing.
 */
export function waitsWithRoom(jobs: readonly Job[], room: Room): boolean {
	return (
		room.memoryPressure < MOST_MEMORY_PRESSURE &&
		waitingInOrder(jobs).some((job) => needsGibOf(job) <= room.availableGib)
	);
}

/** A heredoc's body, from the line after `<<WORD` to WORD alone. */
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;

/** A quoted string: single quotes, or double with its escapes. */
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

/** Where a shell command's steps end. */
const STEPS = /\n|;|&&|\|\|/;

/**
 * The one map from a command to its kind, first match winning. A VM
 * test is a VM or a test driver run here; building a test's driver is a
 * build; a VM check is a Nix build or check of something named for a
 * VM test, which the daemon runs.
 */
const KINDS: readonly (readonly [RegExp, Kind])[] = [
	[
		// Each as a program, not a store path or folder named after one, as
		// `/nix/store/<hash>-nixos-test-driver-1.1/lib` is: a grep there
		// waited for a turn as a VM test.
		/\bqemu-system-[\w-]+(?![\w.*/-])|\bqemu-kvm(?![\w.*/-])|\bnixos-test-driver(?![\w.*/-])|\/bin\/run-[\w-]+-vm\b|(?<![\w./-])run-subtests(?![\w.-])/,
		"vm-test",
	],
	[/\bnix\s+build\b[^\n]*\.driver\b/, "build"],
	// A dry run only evaluates: one naming a VM check waited 16th in line
	// for a VM slot on 29 October.
	[/\bnix\s+build\b[^\n]*\s--dry-run\b/, "build"],
	[
		/\bnix(?:\s+--?\S+)*\s+(?:build|flake\s+check)\b[^\n]*(?:\bvm-|\.vm\b|nixosTests|vmTest)/,
		"vm-check",
	],
	[
		new RegExp(
			`${CHANGED_CHECKS.source}(?=[^\\n]*\\s--build\\b)(?![^\\n]*\\s--no-vm\\b)`,
		),
		"vm-check",
	],
	[new RegExp(`${CARGO}bench\\b|\\bhyperfine\\b`), "benchmark"],
	[
		new RegExp(
			[
				// nix-build as a program, not a build's cgroup or a glob over them,
				// as in `$D/nix-build-*`, which held a read-only loop 315 s.
				/\bnix\s+flake\s+check\b|\bnix\s+build\b|\bnix-build(?![\w.*-])|\bnixos-rebuild\b/,
				// An image for containers, which compiles what it holds.
				/\b(?:podman|docker)\s+(?:buildx\s+|compose\s+)?build\b|\bbuildah\s+(?:build|bud)\b/,
				/\b(?:darwin-rebuild\s+(?:switch|build|check|test)|home-manager\s+(?:switch|build))\b/,
				NIX_FAST_BUILD,
				new RegExp(
					`${CARGO}(?:build|b|check|c|clippy|test|t|nextest|run|r|install|doc|llvm-cov|miri|insta)\\b`,
				),
				/\bmake\b[^\n]*\s-j\s*\d*|\bcmake\s+--build\b|\bgo\s+(?:build|test|install|vet)\b/,
			]
				.map((pattern) => pattern.source)
				.join("|"),
		),
		"build",
	],
	[CHANGED_CHECKS, "build"],
	[EVERY_CHECK, "build"],
];

/**
 * The kind of heavy work a command runs, read only where the shell runs
 * it: text in quotes or a heredoc names work rather than running it.
 * A quoted single word is an argument, as a quoted flake reference
 * such as `"path:$W#checks.x86_64-linux.vm-desktop-works"` is, so it
 * is read; quoted words with spaces between them are prose. A step that
 * only looks, as `pgrep -x qemu-system-x86` does, names work without
 * running it: read as a VM, it waited 30 seconds for a turn and timed
 * out. Nothing for a command that runs none.
 */
export function kindOf(command: string): Kind | undefined {
	const runs = command
		.replace(HEREDOC, "\n")
		// A pipe or a semicolon inside the word is its own, as in
		// `pgrep -af 'run-subtests|changed-checks'`, and splits no step.
		.replace(QUOTED, (quoted) =>
			/\s/.test(quoted) ? "''" : quoted.slice(1, -1).replace(/[|;&]/g, " "),
		)
		.split(SEGMENTS)
		.filter((step) => !LOOKS.test(step.replace(ASSIGNMENTS, "")))
		.join("\n");
	return KINDS.find(([pattern]) => pattern.test(runs))?.[1];
}

/** Each kind as a sentence names one, so every surface says it alike. */
export const KIND_SAID: Readonly<Record<Kind, string>> = {
	"vm-test": "a VM test",
	"vm-check": "a VM check",
	benchmark: "a benchmark",
	build: "a build",
};

/** Where a command's steps and the parts of its pipes end. */
const SEGMENTS = /\n|;|&&|\|\|?/;

/**
 * A git command that only reads the history, past options such as
 * `-C <dir>` and `--no-pager`: `git grep -n 'changed-checks' origin/main`
 * waited 51 s for a turn as an evaluation of every check.
 */
const GIT_READS = String.raw`git(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+(?:grep|log|show|diff|blame|status|ls-files|ls-tree|rev-parse|rev-list|cat-file|shortlog|describe|merge-base)\b`;

/**
 * A step whose command finds processes or text, or reports on them, or
 * reads a file, a path or git's history, as
 * `readlink -f $d/bin/nixos-test-driver` does without running the driver.
 */
const LOOKS = new RegExp(
	String.raw`^\s*(?:sudo\s+)?(?:(?:pgrep|pkill|pidof|ps|kill|killall|grep|egrep|fgrep|rg|systemctl|journalctl|echo|printf|which|readlink|realpath|ls|stat|file|cat|head|tail|wc|test)\b|\[\s|${GIT_READS})`,
);

/**
 * Variables set at the start of a step, as `A=1 B="two" cmd` sets two.
 * One set from `$(` leaves the command inside, since that is what the
 * step runs: `w=$(readlink -f x)` reads, `d=$(nix build ...)` builds.
 */
const ASSIGNMENTS =
	/^\s*(?:export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:\$\(\s*|(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$)))+/;

/**
 * The step of a command that does its heavy work, whole, never a line of
 * a heredoc: a commit message naming changed-checks was once the step
 * named, and the build beside it was held to that tool's memory.
 */
export function stepOf(command: string): string {
	const steps = stepsOf(command);
	return steps.find((one) => kindOf(one) !== undefined) ?? steps[0] ?? "";
}

/**
 * Each step of a command that runs heavy work, in order, as written,
 * with its kind. The queue gives the whole command one turn, as the
 * heaviest of these, so a VM step beside a build makes the build hold a
 * VM slot (shell-habits.ts refuses that).
 */
export function heavySteps(
	command: string,
): { readonly step: string; readonly kind: Kind }[] {
	return stepsOf(command).flatMap((step) => {
		const kind = kindOf(step);
		return kind === undefined ? [] : [{ step, kind }];
	});
}

/**
 * The memory a command of `kind` is held to need, in GiB: its heaviest
 * step's, not its first's. Y9XISP's on 24 October built changed-checks
 * and then ran it, and was held to the build's 4 GiB while the tool
 * used 11.8.
 */
export function needsGibOfCommand(kind: Kind, command: string): number {
	return Math.max(
		needsGibOf({ kind, what: stepOf(command) }),
		...stepsOf(command)
			.filter((step) => kindOf(step) !== undefined)
			.map((step) => needsGibOf({ kind, what: step })),
	);
}

/** A command's steps, in order, each whole, never a line of a heredoc. */
export function stepsOf(command: string): string[] {
	return command
		.replace(HEREDOC, "\n")
		.split(STEPS)
		.map((step) => step.replace(ASSIGNMENTS, "").trim())
		.filter((step) => step !== "");
}

/** How long a job's `what` may be before it is cut. */
const MOST_WHAT = 120;

/** The step of a command that does its heavy work, as one short line. */
export function whatOf(command: string): string {
	const step = stepOf(command);
	return step.length > MOST_WHAT ? `${step.slice(0, MOST_WHAT - 3)}...` : step;
}
