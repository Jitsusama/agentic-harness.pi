/**
 * A job still waiting past when it was due to start (due-to-start.ts):
 * found by a keep, noted once with where it stands and what holds it,
 * and said to its waiter in one line, which its shell prints as it
 * keeps waiting (turn.ts).
 */

import { NOBODY } from "./awaited.ts";
import { floorsBusy } from "./bounds.ts";
import { dueBy } from "./due-to-start.ts";
import type { Job, Late, Room, WaitReason } from "./job.ts";
import { needsGibOf } from "./needs.ts";
import { waitingInOrder } from "./next-turn.ts";

/**
 * The jobs `jobs` holds that are waiting past when they were due to start
 * and were never found so before, each with where it stands at `now`: its
 * place in line, why it waits by `reasons` (next-turn.ts's
 * `waitReasons`), and what holds it, in plain words. A job found once is
 * never found again, so its waiter is told once.
 */
export function lateNow(
	jobs: readonly Job[],
	reasons: ReadonlyMap<string, WaitReason>,
	room: Room,
	now: number,
	awaited: ReadonlySet<string> = NOBODY,
	first: ReadonlySet<string> = NOBODY,
): Map<string, Late> {
	const line = waitingInOrder(jobs, now, awaited, first);
	const found = new Map<string, Late>();
	for (const job of jobs) {
		if (job.started !== undefined || job.late !== undefined) continue;
		const reason = reasons.get(job.id);
		if (reason === undefined || now <= dueBy(job)) continue;
		const at = line.findIndex((one) => one.id === job.id);
		found.set(job.id, {
			at: new Date(now).toISOString(),
			...(at >= 0 ? { place: at + 1 } : {}),
			reason,
			heldBy: heldBy(
				job,
				reason,
				line.slice(0, Math.max(0, at)),
				reasons,
				room,
			),
		});
	}
	return found;
}

/**
 * What a late job's waiter is told, as one line in the voice its shell
 * says how long it waited in, such as "Due to start by 21:40 and still
 * waiting for its turn in the machine queue: 3rd in line, held by memory
 * (some avg10 4.1, 2.5 GiB free of the 6 it needs)." The time is the
 * machine's own, as the mesh says its clock.
 */
export function lateSaid(job: Job, late: Late): string {
	const by = new Date(dueBy(job)).toTimeString().slice(0, 5);
	const place =
		late.place === undefined
			? "not yet in line"
			: `${ordinal(late.place)} in line`;
	return `Due to start by ${by} and still waiting for its turn in the machine queue: ${place}, held by ${late.heldBy}.`;
}

/**
 * What holds a job waiting on `reason`, in plain words: the reading that
 * holds it, as memory pressure and the memory free, or, waiting on the
 * order, the job ahead of it that keeps the line: the first of those
 * `ahead` waiting on memory or behind a VM check, the only waits that
 * hold the jobs after them (next-turn.ts's `waitReasons`). With none, a
 * job ahead of it was just given its turn, or it waits for the next.
 */
function heldBy(
	job: Job,
	reason: WaitReason,
	ahead: readonly Job[],
	reasons: ReadonlyMap<string, WaitReason>,
	room: Room,
): string {
	switch (reason) {
		case "memory":
			return `memory (some avg10 ${tenths(room.memoryPressure)}, ${tenths(room.availableGib)} GiB free of the ${tenths(needsGibOf(job))} it needs)`;
		case "call":
			return "the person's call on this machine, during which only light work starts";
		case "busy":
			return floorsBusy(room)
				? `the person's own programs waiting on CPU (some avg10 ${tenths(room.floorsCpuPressure ?? 0)})`
				: `the machine's CPU (some avg10 ${tenths(room.cpuPressure)}${room.ioPressure === undefined ? "" : `, IO ${tenths(room.ioPressure)}`})`;
		case "vms":
			return `the VMs allowed at once (${room.vms} running)`;
		case "walks":
			return "the walks of World's objects allowed at once";
		case "behind":
			return "a VM check, beside which the builds allowed already run";
		case "lending":
			return "a builder being lent, which will take it";
		case "planning":
			return "its plan, as Nix is asked what it builds";
		case "order": {
			const keeper = ahead.find((one) =>
				HOLDS_THE_LINE.has(reasons.get(one.id) ?? "order"),
			);
			if (keeper === undefined) {
				return ahead.length > 0
					? "the turn just given to a job ahead of it"
					: "the time between turns, its own next";
			}
			const keeps = HOLDS_THE_LINE.get(reasons.get(keeper.id) ?? "order");
			return `job ${keeper.id} ahead of it (${keeper.what}), ${keeps}`;
		}
	}
}

/** The waits that hold the jobs after them in line, not only their own. */
const HOLDS_THE_LINE: ReadonlyMap<WaitReason, string> = new Map<
	WaitReason,
	string
>([
	["memory", "waiting on memory"],
	["behind", "waiting behind a VM check"],
]);

/** A figure to one decimal place, as the queue's record rounds memory. */
function tenths(figure: number): number {
	return Math.round(figure * 10) / 10;
}

/** The endings of 1st, 2nd and 3rd; every other place takes "th". */
const ORDINAL_ENDINGS: ReadonlyMap<number, string> = new Map([
	[1, "st"],
	[2, "nd"],
	[3, "rd"],
]);

/** The ones a place is read by, past which 11 to 13 still take "th". */
const TENS = 10;
const HUNDREDS = 100;
const TEENS = new Set([11, 12, 13]);

/** A place in line as it is said: 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(place: number): string {
	const ending = TEENS.has(place % HUNDREDS)
		? "th"
		: (ORDINAL_ENDINGS.get(place % TENS) ?? "th");
	return `${place}${ending}`;
}
