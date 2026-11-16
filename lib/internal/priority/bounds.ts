/**
 * What the machine can bear beside the work it runs: how many VMs at
 * once, the pressure set points and floors past which work waits, and
 * how long a VM's memory is let settle before the next one starts.
 */

import { NOBODY } from "./awaited.ts";
import {
	isQuick,
	isVm,
	type Job,
	type Pressed,
	type Room,
	type Rules,
} from "./job.ts";
import { THERE_HERE } from "./needs.ts";

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
 * once, while the machine isn't stalling for the person (see
 * {@link vmsAllowedHere}), and {@link FEWER_VMS} while the outcomes say six
 * is too many (see vmsFor in outcome.ts).
 */
export const MOST_VMS = 6;

/**
 * How many VMs run at once for a day while they fail more often at
 * {@link MOST_VMS} than with fewer.
 */
export const FEWER_VMS = 5;

/**
 * Memory pressure (avg10, percent) the programs a memory floor keeps,
 * app.slice's among them, may feel while a VM starts on this machine.
 * Their windows were paged out overnight on 28 October with 5 GiB of
 * app.slice in swap, and each VM more pages them deeper (5FWIUS). That
 * reads 0 until his programs wait, so it costs nothing until then.
 */
export const MOST_FLOORS_PRESSURE = 1;

/**
 * How many VMs may run on this machine itself now: the rule's most while
 * it isn't stalling for the person, and none while it is. A builder's
 * free VM slots come on top, for VM checks alone (see {@link vmWaits}).
 *
 * Stalling is the person's own programs waiting on memory past
 * {@link MOST_FLOORS_PRESSURE}, or CPU pressure at
 * {@link MOST_CPU_PRESSURE_BESIDE_VMS}, past which VMs ran slow. It once
 * held only VMs past the fourth, and a count held none: at 13:53 on 29
 * October Joel's machine was "running like crap" with app.slice stalled
 * 5% and load 49, while VMs kept getting slots below the count, so
 * nothing waited and no cloud builder was lent (P9R1KI). A VM held now
 * waits on `vms`, which is what lends one. Running VMs finish; only new
 * ones wait. Where no floor is read, only CPU counts.
 */
export function vmsAllowedHere(room: Room, rules: Rules): number {
	const stalling =
		floorsWait(room) || room.cpuPressure >= MOST_CPU_PRESSURE_BESIDE_VMS;
	return stalling ? 0 : (rules.mostVms ?? MOST_VMS);
}

/**
 * Whether a VM job must wait for a VM slot. A VM check is a Nix build,
 * which Nix sends to a builder elsewhere while one has a slot free, so
 * it starts on a free builder slot or on this machine's own VM room. A
 * VM test runs its own qemu here, from its shell, so only this
 * machine's room counts for it: counted against a builder's room, it
 * started while the person's programs stalled.
 */
export function vmWaits(
	job: Job,
	at: {
		readonly vmsHere: number;
		readonly vmsElsewhere: number;
		readonly vmSettling: boolean;
	},
	room: Room,
	rules: Rules,
): boolean {
	const noRoomHere = at.vmSettling || at.vmsHere >= vmsAllowedHere(room, rules);
	return job.kind === "vm-test"
		? noRoomHere
		: noRoomHere && at.vmsElsewhere < 1;
}

/**
 * Whether the person's own programs, those a memory floor keeps, stall
 * on memory past {@link MOST_FLOORS_PRESSURE}. Where no floor is read,
 * there is nobody's memory to guard.
 */
export function floorsWait(room: Room): boolean {
	return (
		room.floorsPressure !== undefined &&
		room.floorsPressure > MOST_FLOORS_PRESSURE
	);
}

/** Memory pressure (avg10, percent) past which no job starts. */
export const MOST_MEMORY_PRESSURE = 10;

/**
 * CPU pressure (avg10, percent) the person's own programs, those a
 * memory floor keeps, may feel before no job starts. CPU weights keep
 * them first, so the machine's figure says little of them: at 21:27 on
 * 7 November the machine read 63% while app.slice read 0.3% and
 * session.slice 0.5%, the rest being agents waiting on each other. Past
 * this, the work started is what they wait behind.
 */
export const MOST_FLOORS_CPU_PRESSURE = 5;

/**
 * CPU pressure (avg10, percent) on the whole machine past which no
 * build or benchmark starts, as no VM does past
 * {@link MOST_CPU_PRESSURE_BESIDE_VMS}. At 21:09 on 7 November, with
 * Joel at the desk and the machine at load 66, cargo, clippy and
 * vitest runs from several sessions all started, since only memory held
 * them (80ECO2). Quick work still goes, as it ends in seconds.
 */
export const MOST_CPU_PRESSURE_FOR_BUILDS = 70;

/**
 * Whether the machine is past {@link MOST_CPU_PRESSURE_FOR_BUILDS} over
 * the last ten seconds or the last minute. avg10 alone swings either
 * side of the line: a cargo test held 173 s started at 01:20 on 8
 * November with avg10 read at 79.9%, in a dip between readings, then
 * linked 16 binaries at load 288 (80ECO2).
 */
export function cpuHoldsBuilds(room: Room): boolean {
	return (
		cpuOf(room) >= MOST_CPU_PRESSURE_FOR_BUILDS ||
		(room.ioPressure ?? 0) >= MOST_IO_PRESSURE_FOR_BUILDS
	);
}

/** The machine's CPU pressure, the greater of avg10 and avg60. */
function cpuOf(room: Room): number {
	return Math.max(room.cpuPressure, room.cpuPressureMinute ?? 0);
}

/**
 * IO pressure past which no build or benchmark starts here: at 01:30 on
 * 8 November 48 links of three cargo tests stood in D state at IO
 * pressure 96% and load 429 (P9R1KI).
 */
export const MOST_IO_PRESSURE_FOR_BUILDS = 60;

/**
 * CPU pressure past which a build started here is capped, to
 * {@link CAPPED_NIX}'s cores and cargo's jobs to match: below the line
 * that holds builds, but busy enough that one build's sixteen link jobs
 * would push the machine past it.
 */
export const CAPS_BUILDS_FROM_CPU_PRESSURE = 40;

/** Whether a build given its turn now is capped, for how busy the machine is. */
export function warm(room: Room): boolean {
	return cpuOf(room) >= CAPS_BUILDS_FROM_CPU_PRESSURE;
}

/**
 * Whether the person's own programs wait on CPU past
 * {@link MOST_FLOORS_CPU_PRESSURE}, which holds every job. Where no floor
 * is read, nobody's programs are known to wait.
 */
export function floorsBusy(room: Room): boolean {
	return (
		room.floorsCpuPressure !== undefined &&
		room.floorsCpuPressure > MOST_FLOORS_CPU_PRESSURE
	);
}

/**
 * A step Nix builds through its build hook, which a builder elsewhere
 * takes while one has a slot free: `nix develop -c cargo build` is
 * cargo, run here, so it isn't one.
 */
const HOOK_BUILDS = new RegExp(
	[
		/\bnix(?:\s+--?\S+)*\s+(?:build|flake\s+check)\b|\bnix-build(?![\w.*-])|(?<![\w./-])nix-fast-build(?![\w.-])/
			.source,
		THERE_HERE,
	].join("|"),
);

/**
 * Whether a job must wait while the machine is busy: every job while the
 * person's programs wait on CPU, and a build or benchmark that isn't
 * quick while the machine is past {@link MOST_CPU_PRESSURE_FOR_BUILDS}.
 * A Nix build goes while a builder elsewhere has a build slot free,
 * since it runs there, not here.
 */
export function busyWaits(
	job: Job,
	room: Room,
	first: ReadonlySet<string> = NOBODY,
): boolean {
	if (floorsBusy(room)) return true;
	// A run that sends itself whole to a builder works the CPU there, not
	// here: held at 70%, core's changed-checks waited 46 minutes at place
	// 3 from 00:12 on 8 November though it evaluates nothing here (5FWIUS).
	if (job.sent) return false;
	if (job.kind !== "build" && job.kind !== "benchmark") return false;
	if (isQuick(job) || !cpuHoldsBuilds(room)) return false;
	if (firstAndShort(job, first)) return false;
	const sentElsewhere =
		job.kind === "build" &&
		(room.offload?.builds ?? 0) > 0 &&
		HOOK_BUILDS.test(job.what);
	return !sentElsewhere;
}

/**
 * Seconds a job of a quest first in the line may have run last time and
 * still pass the machine's CPU and IO hold: outcome.ts's `QUICK_S`.
 */
export const FIRST_PASSES_UNDER_S = 60;

/**
 * Whether a job is a queue-first quest's, and ran short last time, so
 * the machine's CPU and IO hold lets it by: memory and the person's own
 * programs still hold it. On 8 November a deploy lane's 13-second cargo
 * test waited 1,524 s, 671 of them on that hold, booked past a quick
 * job's memory by one 5.5 GB peak (L3V9AA, with 5FWIUS's rule).
 */
function firstAndShort(job: Job, first: ReadonlySet<string>): boolean {
	return (
		job.quest !== undefined &&
		first.has(job.quest) &&
		job.lastRanS !== undefined &&
		job.lastRanS < FIRST_PASSES_UNDER_S
	);
}

/** The least rise in a job's memory that counts as its still growing. */
export const GREW_BYTES = 128 * 1024 ** 2;

/**
 * The least time between two VMs starting here. A pressure stall shows
 * seconds after the memory that causes it, so a stall read at each start
 * let four VMs in within three minutes, 16:28 to 16:31 on 29 October,
 * before any one's memory showed: six ran at a 17.6% stall and load 107
 * (P9R1KI). One at a time, each seen to settle, never a burst.
 */
export const VM_SPREAD_MS = 60_000;

/** How long a new VM's memory must hold still before the next may start. */
export const VM_STEADY_MS = 15_000;

/**
 * How long after its start a VM may hold the next back while its memory
 * grows. Past it, a long test's late growth holds nobody.
 */
export const VM_SETTLE_MS = 5 * 60_000;

/**
 * Whether a VM started lately is still settling: started within
 * {@link VM_SPREAD_MS}, or within {@link VM_SETTLE_MS} and its memory
 * rose within {@link VM_STEADY_MS}.
 */
export function vmSettling(jobs: readonly Job[], now: number): boolean {
	return jobs.some((job) => {
		if (!isVm(job) || job.started === undefined) return false;
		const age = now - Date.parse(job.started);
		if (age < VM_SPREAD_MS) return true;
		if (age >= VM_SETTLE_MS || job.grewAt === undefined) return false;
		return now - Date.parse(job.grewAt) < VM_STEADY_MS;
	});
}

/** How many builds run beside a VM check at once. */
export const BUILDS_BESIDE_VMS = 1;

/**
 * CPU pressure (avg10, percent) past which no build starts beside one.
 * It was 10, which only 9 of 741 VM runs from 24 to 29 October ever
 * saw, so builds waited for every VM: from 22:00 on 28 October, 41
 * waited five minutes or more, 485 minutes in all. Over those runs,
 * builds beside raised no failures (3.8% with one, 3.2% with four or
 * more), and VMs ran at their usual time up to 70 (x1.00 at 40 to 70),
 * slowing past it (x1.27). The build beside stays capped, and builds
 * run at idle priority, below the person's programs (5FWIUS).
 */
export const MOST_CPU_PRESSURE_BESIDE_VMS = 70;

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

/**
 * How long a job marked quick runs before it stops holding the quick
 * turn and counts as the build it is: twice the minute that makes work
 * quick (outcome.ts's `QUICK_S`), so a slow look at a loaded machine
 * doesn't count. Quick is learned from the last run, and a build whose
 * last run came from the cache can rebuild for hours: on 29 October a
 * kernel build learned as quick held the one quick turn from 06:19Z,
 * and quick jobs waited 254 of their 302 minutes since 02:00Z behind
 * it, one for 45.8 minutes.
 */
export const QUICK_OUTRUN_MS = 120_000;
