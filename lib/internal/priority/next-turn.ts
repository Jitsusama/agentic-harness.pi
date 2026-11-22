/**
 * Who goes next: the order of the line, the turn a keep gives, why each
 * waiting job waits, and the room left over once the line has had its
 * turns.
 */

import { noun } from "../../ui/count.ts";
import { NOBODY } from "./awaited.ts";
import {
	BUILDS_BESIDE_VMS,
	busyWaits,
	cpuHoldsBuilds,
	firstStartsShort,
	floorsBusy,
	floorsWait,
	MOST_CPU_PRESSURE_BESIDE_VMS,
	MOST_MEMORY_PRESSURE,
	QUICK_AT_ONCE,
	QUICK_OUTRUN_MS,
	vmSettling,
	vmsAllowedHere,
	vmWaits,
	warm,
} from "./bounds.ts";
import {
	isQuick,
	isVm,
	type Job,
	type Room,
	type RoomLeft,
	RULES,
	type Rules,
	type WaitReason,
} from "./job.ts";
import {
	CLASS_OF,
	type Kind,
	LIGHT_GIB,
	NEEDS_GIB,
	needsGibOf,
	runsChangedChecks,
	WALKS_AT_ONCE,
	walksAtOnce,
} from "./needs.ts";

/** How far apart two turns are given. */
export const SPREAD_MS = 3_000;

/** How long a started job's need counts as taken, while it grows. */
export const RAMP_MS = 60_000;

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
	return walksLeadingFirst(
		jobs
			.filter((job) => job.started === undefined && !job.planning)
			.sort(
				(one, other) =>
					rank(one) - rank(other) ||
					waitedOn(one) - waitedOn(other) ||
					putFirst(one) - putFirst(other) ||
					Date.parse(one.since) - Date.parse(other.since) ||
					one.id.localeCompare(other.id),
			),
	);
}

/**
 * The line, with its walks of World's objects reordered among the
 * places walks hold: pushes, fetches of main and a branch's own rebases,
 * cherry-picks, reverts, merges and sparse-checkouts first, then the
 * rest, as fetches of other people's branches, each group in the order
 * it had.
 * Other work keeps its place. On 5 November a push of Joel's waited 61
 * minutes behind review fetches of single branches (80ECO2).
 */
function walksLeadingFirst(line: Job[]): Job[] {
	const places = line.flatMap((job, at) =>
		job.kind === "world-walk" ? [at] : [],
	);
	const walks = line.filter((job) => job.kind === "world-walk");
	const leads = (job: Job) => job.walk !== undefined && job.walk !== "other";
	const ordered = [
		...walks.filter(leads),
		...walks.filter((job) => !leads(job)),
	];
	const reordered = [...line];
	for (const [index, job] of ordered.entries()) {
		const at = places[index];
		if (at !== undefined) reordered[at] = job;
	}
	return reordered;
}

const rank = (job: Job) =>
	CLASS_OF[job.kind] === "timed" ? 0 : isQuick(job) ? 1 : 2;

/**
 * Whether a job starts while the machine is short of memory: quick work
 * other than a build, held to no more than {@link LIGHT_GIB}, and a
 * changed-checks run that sends itself whole, whose Nix builds are the
 * builder's rather than this machine's daemon's. Its booking still has
 * to fit. Held here, 30 sent runs from 14:00 on 10 November peaked at
 * 0.4 GB at most yet waited 14,016 s on memory, a third of each one's
 * time to its result (80ECO2). A sent `nix-offload there
 * --here-when-idle` stays held: idle by CPU, it may build here while
 * memory is short.
 */
function startsPressed(job: Job): boolean {
	if (job.sent === true && runsChangedChecks(job.what)) return true;
	return isQuick(job) && job.kind !== "build" && needsGibOf(job) <= LIGHT_GIB;
}

/**
 * What starts while the machine is short of memory, given the line:
 * what {@link startsPressed} lets start, and one job of a quest put
 * first at a time, while bounds.ts's `firstStartsShort` lets it. One at
 * a time, since each such job adds its memory to a machine already
 * short; an answered fetch, which holds no memory to speak of, and work
 * that starts while short anyway take no place.
 */
function pressedStarts(
	jobs: readonly Job[],
	room: Room,
	first: ReadonlySet<string>,
): (job: Job) => boolean {
	const firstRunning = jobs.some(
		(one) =>
			one.started !== undefined &&
			!one.answered &&
			!startsPressed(one) &&
			one.quest !== undefined &&
			first.has(one.quest),
	);
	return (job) =>
		startsPressed(job) || (!firstRunning && firstStartsShort(job, room, first));
}

/**
 * How long a job waits on memory before jobs that fit may pass it, while
 * it needs more than the running jobs could free (see {@link lineKept}).
 */
export const PASS_AFTER_MS = 5 * 60_000;

/**
 * How soon the memory a job waits for must be due back for it to hold
 * everyone behind it: past this, it holds back only work that would
 * still run by then (see {@link lineKept}).
 */
export const KEEPS_LINE_FOR_MS = 5 * 60_000;

/** Which of the jobs behind it a job holds back. */
type Holds = (job: Job) => boolean;

const HOLDS_ALL: Holds = () => true;
const HOLDS_NONE: Holds = () => false;

/** What either holds back. */
function either(one: Holds, other: Holds): Holds {
	return (job) => one(job) || other(job);
}

/**
 * What the jobs behind `job`, which waits, are held back by once it
 * does. While memory is short a queue-first job that got this far only
 * by the first quests' pass holds no work that starts while short
 * anyway: before that pass every job held while short stopped short of
 * here, so a sent changed-checks run, built on the builder, started past
 * them all. It still holds the first quests' other jobs as the line
 * does, so their smaller ones never starve it.
 */
function keptBehind(
	holds: Holds,
	pressed: boolean,
	job: Job,
	ruledOut: boolean,
	jobs: readonly Job[],
	room: Room,
	now: number,
): Holds {
	const kept = ruledOut ? HOLDS_ALL : lineKept(job, jobs, room, now);
	if (pressed && !startsPressed(job)) {
		return either(holds, (behind) => !startsPressed(behind) && kept(behind));
	}
	return either(holds, kept);
}

/**
 * Which jobs behind `job`, which memory holds back, it holds back too.
 * Everyone, until it has waited on memory past {@link PASS_AFTER_MS}.
 * Then nobody, while it needs more than can be freed, the memory
 * available now and what the running jobs past their ramp are held to
 * need, since only they hand memory back to the queue. A job still in
 * its ramp has yet to take its need, which the memory available counts
 * as free already.
 *
 * A job the queue's own work holds back keeps the line, so the memory
 * those jobs give back goes to it, but only for what would be in its
 * way: everyone while that memory is due back within
 * {@link KEEPS_LINE_FOR_MS}, and past that only work whose last run
 * says it would still run when the memory comes back. On 3 November a
 * changed-checks --build (mw192vak) held 13 GiB from 22:58Z to 00:45Z,
 * and a 20 GiB flake check (mw196uoj)
 * and a 24 GiB evaluation (mw18aruy) waiting on that memory held 30
 * tests of 1 to 171 s that fit, each waiting 4,300 to 4,570 s on the
 * order (16V6F4). Work never seen passes too: once running, it counts
 * as due once it has run as long again (see {@link endsAt}), so the job
 * it passed holds the line again as soon as that end would fit it.
 *
 * A job held back by what the queue doesn't run held everyone for
 * nothing. On 3 November a 24 GiB
 * evaluation of every check (mw13l2lv) waited 4,473 s on memory from
 * 19:45Z; from 20:05Z no queued job but one of 10 s ran, so nothing the
 * queue ran could free its room. By the time it was given up, at
 * 21:00:06Z, the day's ended jobs had waited 35.7 hours on the order and
 * 32 had been given up; ten behind it waited 7.1 hours of that from
 * 20:05Z, five of them given up. It keeps its place and
 * starts once it fits, and once the jobs passing it hold enough that
 * their end would fit it, it holds the line again, so it never starves.
 */
function lineKept(
	job: Job,
	jobs: readonly Job[],
	room: Room,
	now: number,
): Holds {
	if (memoryWaitedMs(job, now) <= PASS_AFTER_MS) return HOLDS_ALL;
	const back = roomBackAt(job, jobs, room, now);
	if (back === undefined) return HOLDS_NONE;
	if (back - now <= KEEPS_LINE_FOR_MS) return HOLDS_ALL;
	return (behind) =>
		behind.lastRanS !== undefined && now + behind.lastRanS * 1000 > back;
}

/**
 * When `job` would fit, as the running jobs past their ramp end, those
 * due first counted first (see {@link endsAt}), or nothing when it
 * wouldn't fit with all of them ended.
 */
function roomBackAt(
	job: Job,
	jobs: readonly Job[],
	room: Room,
	now: number,
): number | undefined {
	const short = needsGibOf(job) - room.availableGib;
	if (short <= 0) return now;
	const ending = jobs
		.filter(
			(one) =>
				one.started !== undefined && now - Date.parse(one.started) >= RAMP_MS,
		)
		.map((one) => ({ at: endsAt(one, now), gib: needsGibOf(one) }))
		.sort((one, other) => one.at - other.at);
	let freed = 0;
	for (const one of ending) {
		freed += one.gib;
		if (freed >= short) return one.at;
	}
	return undefined;
}

/**
 * When a running job is due to end: by how long its work last took, or,
 * when that is unknown or already past, as long again as it has run. The
 * same work's runs vary too widely to trust past their length: the
 * changed-checks --build of 3 November ran 6,402 s, its last 1,010 s,
 * and its runs that day 2 to 12,197 s. Work just started is due soon,
 * so a job it passed holds the line again once its end would fit.
 */
function endsAt(job: Job, now: number): number {
	if (job.started === undefined) return now;
	const started = Date.parse(job.started);
	const byLast =
		job.lastRanS === undefined
			? Number.NEGATIVE_INFINITY
			: started + job.lastRanS * 1000;
	return byLast > now ? byLast : now + (now - started);
}

/** How long a job has waited on memory, every stretch of it, by `now`. */
function memoryWaitedMs(job: Job, now: number): number {
	const before = job.waitedOnMs?.memory ?? 0;
	const was = job.waitingSince;
	return was?.reason === "memory"
		? before + Math.max(0, now - Date.parse(was.at))
		: before;
}

/**
 * The version of how this code gives turns. Raise it with every change
 * to who gets a turn when, so a session on older code leaves keeping the
 * queue to one on this (keeper.ts), and with a change to how it keeps
 * the folder that older keepers would undo. 1: VM starts paced (#884),
 * builder slots counted free (#881), slow builds held for a lend (#882,
 * #883). 2: queue.json left to the heartbeat for pressure alone (#892),
 * which eight sessions busy on older code since the morning of 30
 * October kept undoing, at 70 writes in 20 s. 3: the lock taken in a
 * folder of its own inside the queue's, where a keeper still taking the
 * old one would keep beside a keeper taking the new. 4: jobs that fit
 * pass one memory has held past {@link PASS_AFTER_MS} and the running
 * jobs can't free room for (see {@link lineKept}). 5: past
 * {@link KEEPS_LINE_FOR_MS}, a job memory holds back holds only the work
 * that would still run when its memory is due back. 6: walks of World's
 * objects, a kind older code can't read, held to {@link WALKS_AT_ONCE}.
 * 7: pushes and fetches of main first among the walks, and a fetch of
 * main waiting for one running, then answered by it (fetched.ts). 8:
 * a folder kept within folder.ts's `KEPT_FOR_MS`, with nothing come or
 * gone since, left as it is, which older keepers would keep regardless.
 * 9: no job starts while the person's programs wait on CPU, no build or
 * benchmark past bounds.ts's `MOST_CPU_PRESSURE_FOR_BUILDS`, and vitest and
 * the pnpm scripts that run it are builds. 10: a deploy's stamp, a kind
 * older code can't read, goes first with only the capped build beside.
 * 11: builds held on the minute's CPU and on IO too, capped from 40%,
 * and a changed-checks sent whole to a builder spared the holds. 12: a
 * push of World that leaves out its LFS scan is quick work, held to
 * needs.ts's `PUSH_GIB` or what it was seen to hold, and quick work held to
 * {@link LIGHT_GIB} or less, builds aside, starts while memory is short.
 * 13: walks of World's objects one at a time from needs.ts's
 * `ONE_WALK_FROM_PRESSURE`, and git's rebase, cherry-pick, merge and
 * sparse-checkout in a World checkout read as walks. 14: no walk starts
 * beside one started within {@link WALK_SETTLES_MS}, and git's revert in
 * a World checkout reads as a walk. 15: a quick push opens no settling
 * window, and a command chaining another walk before a push is no quick
 * push, though its push still leaves out its LFS scan. 16: one job of a
 * quest put first starts while memory is short, up to bounds.ts's
 * `FIRST_MOST_MEMORY_FULL` of full avg60 while the floors aren't
 * stalling, held to `FIRST_MOST_GIB_SHORT`; one that doesn't fit then
 * holds nobody behind it.
 */
export const RULES_VERSION = 16;

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
	// An answered fetch takes nothing, so it spaces out nobody's turn.
	const last = Math.max(
		Number.NEGATIVE_INFINITY,
		...running
			.filter((job) => !job.answered)
			.map((job) => Date.parse(job.started as string)),
	);
	if (now - last < SPREAD_MS) return undefined;
	const pressed = room.memoryPressure >= MOST_MEMORY_PRESSURE;
	const startsShort = pressedStarts(jobs, room, first);
	const waitingJobs = jobs.filter((job) => job.started === undefined);
	if (pressed && !waitingJobs.some(startsShort)) return undefined;
	if (floorsBusy(room)) return undefined;
	const { growing, vmsHere, vmsElsewhere, settling, builds, quick, walks } =
		standing(jobs, room, now, rules);
	const fits = (job: Job) => room.availableGib - growing >= needsGibOf(job);
	const waiting = waitingInOrder(jobs, awaited, first);
	const fetching = fetchingMain(jobs, now);
	// Quick work passes older work, one job at a time: it ends in seconds,
	// so what it passes waits seconds longer, never starved by a stream.
	const passes = (job: Job) =>
		waiting.some(
			(other) =>
				!isQuick(other) && Date.parse(other.since) < Date.parse(job.since),
		);
	let holds = HOLDS_NONE;
	for (const job of waiting) {
		if (pressed && !startsShort(job)) continue;
		if (isQuick(job)) {
			const queuedPast = passes(job) && quick.running >= QUICK_AT_ONCE;
			if (quick.left < 1 || queuedPast || !fits(job)) continue;
			return Number.isFinite(quick.left) ? { ...job, capped: true } : job;
		}
		if (holds(job) || waitsForLending(job, room, now)) continue;
		if (busyWaits(job, room, first)) continue;
		if (
			isVm(job) &&
			vmWaits(job, { vmsHere, vmsElsewhere, vmSettling: settling }, room, rules)
		) {
			continue;
		}
		if (walkWaits(job, walks, fetching, room)) continue;
		// Only bulk work is behind a build, and it all waits with it.
		const ruledOut =
			job.kind === "build" &&
			(builds < 1 || (Number.isFinite(builds) && !job.cappable));
		if (ruledOut || !fits(job)) {
			holds = keptBehind(holds, pressed, job, ruledOut, jobs, room, now);
			continue;
		}
		return job.kind === "build" && (Number.isFinite(builds) || warm(room))
			? { ...job, capped: true }
			: job;
	}
	return undefined;
}

/**
 * The longest a job waits for a builder being lent, past the 70 to 130 s
 * one takes to boot, so a lend that fails or hangs holds nobody long.
 */
export const LENDING_WAIT_MS = 180_000;

/**
 * Whether a job waits for the builder being lent. One `nix build` keeps
 * the build hook it starts with, and a hook that found no builder then
 * never offloads, so a build started while the builder boots ran wholly
 * here: 2HN63P's guide-recover at 15:48 on 29 October (5FWIUS, from
 * Nix's source). A build no quicker than its last run says waits for it;
 * a quick one goes, since the builder takes only big work. A VM check
 * goes too: through the hook its inputs' upload took 16.7 of 17 minutes
 * against a minute here, so the lent builder takes no VM work (5FWIUS,
 * 16:23 on 29 October).
 */
function waitsForLending(job: Job, room: Room, now: number): boolean {
	return (
		room.lendingSince !== undefined &&
		now - room.lendingSince < LENDING_WAIT_MS &&
		!isQuick(job) &&
		job.kind === "build"
	);
}

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
	const pressed = room.memoryPressure >= MOST_MEMORY_PRESSURE;
	const startsShort = pressedStarts(jobs, room, first);
	const heldPressed = (job: Job) => pressed && !startsShort(job);
	for (const job of waiting) {
		if (heldPressed(job)) reasons.set(job.id, "memory");
	}
	if (floorsBusy(room)) {
		for (const job of waiting) {
			if (!heldPressed(job)) reasons.set(job.id, "busy");
		}
		return reasons;
	}
	const { growing, vmsHere, vmsElsewhere, settling, builds, quick, walks } =
		standing(jobs, room, now, rules);
	const fits = (job: Job) => room.availableGib - growing >= needsGibOf(job);
	const fetching = fetchingMain(jobs, now);
	const passes = (job: Job) =>
		waiting.some(
			(other) =>
				!isQuick(other) && Date.parse(other.since) < Date.parse(job.since),
		);
	let holds = HOLDS_NONE;
	let given = false;
	for (const job of waiting) {
		if (heldPressed(job)) continue;
		const reason = ((): WaitReason => {
			if (isQuick(job)) {
				if (quick.left < 1) return "behind";
				if (passes(job) && quick.running >= QUICK_AT_ONCE) return "order";
				if (!fits(job)) return "memory";
				given = true;
				return "order";
			}
			if (waitsForLending(job, room, now)) return "lending";
			if (holds(job) || given) return "order";
			if (busyWaits(job, room, first)) return "busy";
			if (
				isVm(job) &&
				vmWaits(
					job,
					{ vmsHere, vmsElsewhere, vmSettling: settling },
					room,
					rules,
				)
			) {
				return "vms";
			}
			if (walkWaits(job, walks, fetching, room)) return "walks";
			const ruledOut =
				job.kind === "build" &&
				(builds < 1 || (Number.isFinite(builds) && !job.cappable));
			if (ruledOut || !fits(job)) {
				holds = keptBehind(holds, pressed, job, ruledOut, jobs, room, now);
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
 * Whether a walk of World's objects must wait for another to end: the
 * walks allowed at once are running, or it fetches main while a fetch
 * of main runs, which will answer it as it ends (fetched.ts). On the
 * evening of 5 November four fetches of main waited up to 75 minutes
 * behind one already running, each to fetch the same commits again
 * (80ECO2). The walks allowed are needs.ts's `walksAtOnce` for the
 * memory pressure `room` reads, and one while a walk started within
 * {@link WALK_SETTLES_MS} runs, since the pressure a walk causes shows in
 * the minute's figure only once it has mapped its packs. Like a VM held to
 * its count, it lets the jobs behind it past.
 */
function walkWaits(
	job: Job,
	walks: Walks,
	fetching: boolean,
	room: Room,
): boolean {
	if (job.kind !== "world-walk") return false;
	const allowed = walks.settling ? 1 : walksAtOnce(room.memoryFullMinute);
	return walks.running >= allowed || (job.walk === "main-fetch" && fetching);
}

/**
 * How long after its start a walk of World's objects keeps a second from
 * starting beside it, however the minute's pressure reads: the figure is
 * an average over a minute, so a walk asking seconds after another would
 * read the calm from before it.
 */
export const WALK_SETTLES_MS = 60_000;

/** The walks of World's objects running, and whether one is settling. */
interface Walks {
	readonly running: number;
	/** One started within {@link WALK_SETTLES_MS}. */
	readonly settling: boolean;
}

/**
 * How long a fetch of main runs before the fetches waiting on it stop
 * waiting and take their own turns, so one that hangs holds them no
 * longer than it would have as a walk ahead in line. Fetches of main
 * from 4 to 5 November ran a median 108 s, and nine in ten under 11
 * minutes.
 */
export const JOINS_FOR_MS = 20 * 60_000;

/**
 * Whether a fetch of World's main runs that the fetches of main waiting
 * may join: started on these rules, not itself answered, and running
 * under {@link JOINS_FOR_MS}.
 */
function fetchingMain(jobs: readonly Job[], now: number): boolean {
	return jobs.some(
		(job) =>
			job.started !== undefined &&
			job.walk === "main-fetch" &&
			!job.answered &&
			now - Date.parse(job.started) < JOINS_FOR_MS,
	);
}

/**
 * What running work holds: memory still growing, VMs, how many builds
 * may start beside a VM check (all of them, with none running), how
 * many quick jobs run and may start, and the walks of World's objects.
 */
function standing(
	jobs: readonly Job[],
	room: Room,
	now: number,
	rules: Rules,
): {
	growing: number;
	/** VMs running on this machine itself: its VM tests, or its qemu. */
	vmsHere: number;
	/** A builder's VM slots free and not yet spoken for. */
	vmsElsewhere: number;
	/** A VM started lately is still settling (see {@link vmSettling}). */
	settling: boolean;
	builds: number;
	quick: { running: number; left: number };
	walks: Walks;
} {
	// An answered fetch walks nothing and holds no memory to speak of.
	const running = jobs.filter(
		(job) => job.started !== undefined && !job.answered,
	);
	const growing = running
		.filter((job) => now - Date.parse(job.started as string) < RAMP_MS)
		.reduce((sum, job) => sum + needsGibOf(job), 0);
	const tests = running.filter((job) => job.kind === "vm-test").length;
	// A VM check just given its turn is still evaluating: it holds no
	// builder slot and runs no qemu yet, so it counts against both, and
	// the machine's qemu count holds VMs outside the queue.
	const justStarted = running.filter(
		(job) =>
			job.kind === "vm-check" &&
			now - Date.parse(job.started as string) < RAMP_MS,
	).length;
	const vmsHere = Math.max(tests + justStarted, room.vms);
	const vmsElsewhere = Math.max(0, (room.offload?.vms ?? 0) - justStarted);
	// A deploy's stamp runs with only the capped build beside, as a VM
	// check does, so ten builds no longer slow it fourfold.
	const checking =
		(rules.buildsWaitForVmChecks &&
			(running.some((job) => job.kind === "vm-check") || room.vms > tests)) ||
		running.some((job) => job.kind === "stamp");
	const stillQuick = (job: Job) =>
		isQuick(job) && now - Date.parse(job.started as string) < QUICK_OUTRUN_MS;
	const quickRunning = running.filter(stillQuick).length;
	const beside = running.filter(
		(job) => job.kind === "build" && !stillQuick(job),
	).length;
	// Beside a VM check: the one capped build here while the machine has
	// the CPU and the person's memory to spare, and a builder's slots
	// whatever this machine feels, since a build there presses neither.
	const here =
		room.cpuPressure < MOST_CPU_PRESSURE_BESIDE_VMS && !floorsWait(room)
			? BUILDS_BESIDE_VMS
			: 0;
	const builds = !checking
		? Number.POSITIVE_INFINITY
		: Math.max(0, here - beside) + (room.offload?.builds ?? 0);
	const quick = {
		running: quickRunning,
		left: checking
			? Math.max(0, QUICK_AT_ONCE - quickRunning)
			: Number.POSITIVE_INFINITY,
	};
	return {
		growing,
		vmsHere,
		vmsElsewhere,
		settling: vmSettling(running, now),
		builds,
		quick,
		walks: {
			running: running.filter((job) => job.kind === "world-walk").length,
			// A quick push maps no packs, so it has no pressure to settle.
			settling: running.some(
				(job) =>
					job.kind === "world-walk" &&
					!isQuick(job) &&
					now - Date.parse(job.started as string) < WALK_SETTLES_MS,
			),
		},
	};
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
	if (room.memoryPressure >= MOST_MEMORY_PRESSURE || floorsBusy(room)) {
		return { vms: 0, builds: 0 };
	}
	const { growing, vmsHere, vmsElsewhere, settling, builds } = standing(
		jobs,
		room,
		now,
		rules,
	);
	const waiting = waitingInOrder(jobs);
	const free =
		room.availableGib -
		growing -
		waiting.reduce((sum, job) => sum + needsGibOf(job), 0);
	const fits = (kind: Kind) => Math.max(0, Math.floor(free / NEEDS_GIB[kind]));
	const slots = Math.max(
		0,
		(settling ? 0 : Math.max(0, vmsAllowedHere(room, rules) - vmsHere)) +
			vmsElsewhere -
			waiting.filter(isVm).length,
	);
	// A build waiting is held by memory or the rule, and so is the next.
	const buildWaits = waiting.some((job) => job.kind === "build");
	const cpuHolds = cpuHoldsBuilds(room);
	return {
		vms: buildWaits && builds < 1 ? 0 : Math.min(fits("vm-test"), slots),
		builds: buildWaits || cpuHolds ? 0 : Math.min(fits("build"), builds),
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
	// Waiting while the machine is busy is the rule's aim, not a waste.
	return (
		room.memoryPressure < MOST_MEMORY_PRESSURE &&
		!floorsBusy(room) &&
		!cpuHoldsBuilds(room) &&
		waitingInOrder(jobs).some((job) => needsGibOf(job) <= room.availableGib)
	);
}
