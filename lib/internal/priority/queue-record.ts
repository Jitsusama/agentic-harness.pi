/**
 * What queue.json says: the whole queue as one record, written whole
 * by whichever session keeps the queue and read by the launcher, the
 * mesh and, from outside the harness, mycelium's node. Its shape
 * changes for those readers; how the folder is kept changes apart.
 */

import { NOBODY } from "./awaited.ts";
import type { Processes } from "./folder.ts";
import { workNameIn } from "./name.ts";
import { type Outcome, ranSAfter } from "./outcome.ts";
import {
	CLASS_OF,
	type Class,
	type Job,
	needsGibOf,
	type Offload,
	type Pressed,
	pressedPast,
	type RoomLeft,
	RULES,
	type Rules,
	roomLeft,
	type WaitReason,
	waitingInOrder,
	waitReasons,
	waitsWithRoom,
} from "./queue.ts";
import type { Reading } from "./room.ts";

/**
 * The whole queue, as queue.json holds it. mycelium's node reads `v`,
 * `at`, `heartbeat`, `machine` and `room` from outside the harness, so a
 * change to any of those five bumps `v`; a field added to them doesn't,
 * and the rest may change freely.
 */
export interface QueueRecord {
	readonly v: 1;
	readonly at: string;
	/** When it was last written, in epoch seconds. */
	readonly heartbeat: number;
	readonly machine: {
		readonly cores: number;
		readonly availableGib: number;
		readonly pressure: Reading["pressure"];
		/**
		 * The share of the last minute everything stalled on memory (full
		 * avg60), which a queue-first quest's job is held to while memory is
		 * short; left out where it isn't read.
		 */
		readonly memoryFullMinute?: number;
		readonly vms: number;
		/** The queue's pressure limits the machine is at or past now. */
		readonly over: readonly Pressed[];
		/** The slots of builders elsewhere, counted as room here while they stand. */
		readonly offload?: Offload;
		/**
		 * How fast the uplink sends, once measured. The shell paces the
		 * sessions it tells to carry on after a reboot by it; no turn here
		 * waits on it.
		 */
		readonly uplink?: Reading["uplink"];
	};
	/** How many more VMs and builds would get their turns now. */
	readonly room: RoomLeft;
	readonly quiet: null;
	readonly jobs: readonly {
		readonly id: string;
		readonly class: Class;
		readonly kind: Job["kind"];
		readonly state: "running" | "waiting";
		readonly owner: Job["owner"];
		readonly what: string;
		readonly memoryGib: number;
		/** When it started, or began to wait. */
		readonly since: string;
		/** Its place in line, from 1, while it waits. */
		readonly place?: number;
		/** The cgroup it runs in, while it runs. */
		readonly slice?: string;
		/** Started beside a VM check, with its Nix builds capped. */
		readonly capped?: true;
		/** A build that takes seconds, with a turn of its own. */
		readonly quick?: true;
		/** The quest its session had loaded as it asked. */
		readonly quest?: string;
		/** Its quest is marked `queue: first`, so it goes ahead of bulk. */
		readonly first?: true;
		/** Waiting, and another session waits on its owner, so it goes first. */
		readonly awaited?: true;
		/**
		 * What it builds, by name, such as a check's: read from a running
		 * job's own processes, or from `what` where it is written out.
		 */
		readonly name?: string;
		/** How many seconds the same work took the last time it ran. */
		readonly lastRanS?: number;
		/** Why it waits, while it waits. */
		readonly waitingOn?: WaitReason;
	}[];
	/** Minutes some job waited today though the memory it needed was free. */
	readonly wasted: {
		readonly today: number;
		readonly day: string;
		readonly minute: string;
	};
}

/**
 * What a record says that is worth writing at once: everything but when
 * it was written, the machine's pressure, its free memory and its
 * uplink's rate, which change in nearly every reading and wait for the
 * heartbeat. It is held
 * against the file rather than what this session last wrote, since every
 * session keeps the queue in turn. Under ten VMs on 30 October the file
 * was replaced 123 times in 10 s, each costing the shell about 20
 * wakeups; what pressure means for a turn still shows at once, in
 * `over` and `room`.
 */
export function shapeOf(record: QueueRecord | undefined): string {
	if (!record?.machine) return "";
	const {
		pressure: _pressure,
		availableGib: _free,
		uplink: _sent,
		...machine
	} = record.machine;
	return JSON.stringify({ ...record, at: "", heartbeat: 0, machine });
}

/** The whole queue as queue.json holds it, counting a wasted minute. */
export function queueRecord(
	jobs: readonly Job[],
	reading: Reading,
	now: number,
	before: QueueRecord | undefined,
	processes: Pick<Processes, "cgroupOf" | "commandsIn">,
	shellOf: (id: string) => number | undefined = () => undefined,
	rules: Rules = RULES,
	awaited: ReadonlySet<string> = NOBODY,
	first: ReadonlySet<string> = NOBODY,
	outcomes: readonly Outcome[] = [],
): QueueRecord {
	const at = new Date(now).toISOString();
	const day = at.slice(0, 10);
	const minute = at.slice(0, 16);
	const carried =
		before?.wasted?.day === day ? before.wasted : { today: 0, day, minute: "" };
	const wasted =
		waitsWithRoom(jobs, reading) && carried.minute !== minute
			? { today: carried.today + 1, day, minute }
			: carried;
	const waiting = waitingInOrder(jobs, awaited, first);
	const reasons = waitReasons(jobs, reading, now, rules, awaited, first);
	return {
		v: 1,
		at,
		heartbeat: Math.floor(now / 1000),
		machine: {
			cores: reading.cores,
			availableGib: Math.round(reading.availableGib * 10) / 10,
			pressure: reading.pressure,
			...(reading.memoryFullMinute === undefined
				? {}
				: { memoryFullMinute: reading.memoryFullMinute }),
			vms: reading.vms,
			over: pressedPast(reading),
			...(reading.offload ? { offload: reading.offload } : {}),
			...(reading.uplink ? { uplink: reading.uplink } : {}),
		},
		room: roomLeft(jobs, reading, now, rules),
		quiet: null,
		jobs: [
			...jobs.filter((job) => job.started !== undefined),
			...waiting,
			...jobs.filter((job) => job.started === undefined && job.planning),
		].map((job) => {
			const shell = shellOf(job.id);
			const slice =
				job.started !== undefined && shell !== undefined
					? processes.cgroupOf(shell)
					: undefined;
			const name =
				(slice !== undefined
					? workNameIn(processes.commandsIn?.(slice) ?? [])
					: undefined) ?? workNameIn([job.what]);
			const lastRanS = ranSAfter(job.what, outcomes);
			const waitingOn =
				job.started === undefined ? reasons.get(job.id) : undefined;
			return {
				id: job.id,
				class: CLASS_OF[job.kind],
				kind: job.kind,
				state: job.started !== undefined ? "running" : "waiting",
				owner: job.owner,
				what: job.what,
				memoryGib: needsGibOf(job),
				since: job.started ?? job.since,
				...(job.started === undefined && !job.planning
					? { place: waiting.indexOf(job) + 1 }
					: {}),
				...(job.started === undefined && awaited.has(job.owner.session)
					? { awaited: true as const }
					: {}),
				...(slice !== undefined ? { slice } : {}),
				...(job.capped ? { capped: true as const } : {}),
				...(job.quick ? { quick: true as const } : {}),
				...(job.quest !== undefined ? { quest: job.quest } : {}),
				...(job.quest !== undefined && first.has(job.quest)
					? { first: true as const }
					: {}),
				...(name !== undefined ? { name } : {}),
				...(lastRanS !== undefined ? { lastRanS } : {}),
				...(waitingOn !== undefined ? { waitingOn } : {}),
			};
		}),
		wasted,
	};
}
