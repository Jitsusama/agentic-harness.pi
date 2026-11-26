/**
 * Whether the machine has the memory to start a council's reviewers.
 *
 * A council starts several pis at once, each holding a pi's worth of
 * memory for minutes. Rounds used to start a fixed three minutes apart
 * whatever the machine had to spare, so on 24 November one waited about
 * 30 minutes behind ten others on a machine with room for all of them,
 * and on a starved one three minutes was no guard at all. The rule now
 * is room alone. On Linux a round starts while the share of the last
 * minute every task spent stalled on memory, the kernel's `full avg60`,
 * is under 5, and while 16 GB is available, or a quarter of a smaller
 * machine's memory. On 26 November 24 rounds ran at once at an avg60
 * of 8.23 under the old bar of 10, with Joel at the machine, and
 * velocity set this one (A210E4CA).
 *
 * A Mac keeps no such figure, so it reads the rule the machine queue
 * reads there (room-darwin.ts): the kernel's pressure level, a swap-out
 * within the last minute, or too little memory available. On 25
 * November a Mac swapped hard while rounds still started on it, as the
 * Linux rule read a missing file as room, and Joel's window froze.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	LOCK_FOLDER,
	machineQueueDir,
} from "../../../internal/priority/folder.ts";
import {
	darwinShort,
	historyIn,
	keptAt,
	type MemoryFigures,
	SWAPPING_MS,
	type SwapHistory,
	type Swapped,
	swapoutsReadIn,
	sysctlValues,
} from "../../../internal/priority/room-darwin.ts";

/** The kernel's memory pressure, where Linux keeps it. */
export const MEMORY_PRESSURE_FILE = "/proc/pressure/memory";

/** Where Linux says how much memory it has and how much is available. */
export const MEMINFO_FILE = "/proc/meminfo";

/** The `full avg60` at and past which a round waits for room. */
export const FULL_AVG60_AT_MOST = 5;

/**
 * The memory a round wants available before it starts, in bytes: 16 GB,
 * or a quarter of a machine with less than 64 GB, which could otherwise
 * never start one.
 */
export const LEAST_AVAILABLE_BYTES = 16e9;

/** The share of a machine's memory {@link LEAST_AVAILABLE_BYTES} gives way to. */
const LEAST_AVAILABLE_SHARE = 0.25;

/**
 * How long the rounds of a process wait on a Mac whose room they can't
 * judge, unreadable or with no reading old enough, before they start
 * anyway and say so. Velocity lets a round wait a quarter of an hour at
 * most (A210E4CA, 26 November), and a round starts a look and a spacing
 * after this, so it is well under that.
 */
export const UNJUDGED_WAIT_MS = 10 * 60_000;

/**
 * How long one reading of a Mac, or its failure, serves every round in
 * this process: longer than the 15 s a waiting round looks again, so a
 * process runs `sysctl` and `vm_stat` once a look, whatever its rounds.
 */
export const MAC_READING_SERVES_MS = 20_000;

/** How long `sysctl` or `vm_stat` may take before the reading fails. */
const PROGRAM_TIMEOUT_MS = 5_000;

const FULL_AVG60 = /^full\b.*\bavg60=(\d+(?:\.\d+)?)/m;
const MEMINFO_KB = (name: string) => new RegExp(`^${name}:\\s+(\\d+) kB$`, "m");

/** Where Linux's figures come from, each read again at every look. */
export interface LinuxSources {
	readonly pressure: () => Promise<string>;
	readonly meminfo: () => Promise<string>;
}

const THIS_LINUX: LinuxSources = {
	pressure: () => readFile(MEMORY_PRESSURE_FILE, "utf8"),
	meminfo: () => readFile(MEMINFO_FILE, "utf8"),
};

/**
 * What keeps a round from starting now, said for its answer, or nothing
 * when the machine has room. A figure that can't be had holds nothing
 * back, as on an old kernel: a Mac reads {@link macRoundRoom} instead.
 */
export async function memoryShort(
	sources: LinuxSources = THIS_LINUX,
): Promise<string | undefined> {
	const [pressure, meminfo] = await Promise.all([
		textOf(sources.pressure),
		textOf(sources.meminfo),
	]);
	const said = pressure === undefined ? undefined : FULL_AVG60.exec(pressure);
	if (said?.[1] !== undefined && Number(said[1]) >= FULL_AVG60_AT_MOST) {
		return `memory full avg60 was ${Number(said[1])}, at or past ${FULL_AVG60_AT_MOST}`;
	}
	return meminfo === undefined ? undefined : availableShort(meminfo);
}

/** The text a source gives, or undefined when it can't be read. */
async function textOf(
	read: () => Promise<string>,
): Promise<string | undefined> {
	try {
		return await read();
	} catch {
		// A file the kernel doesn't keep says nothing about room.
		return undefined;
	}
}

/** Why too little memory is available by `meminfo`, or nothing. */
function availableShort(meminfo: string): string | undefined {
	const kb = (name: string) => {
		const found = MEMINFO_KB(name).exec(meminfo)?.[1];
		return found === undefined ? undefined : Number(found) * 1024;
	};
	const available = kb("MemAvailable");
	const total = kb("MemTotal");
	if (available === undefined || total === undefined) return undefined;
	const least = Math.min(LEAST_AVAILABLE_BYTES, total * LEAST_AVAILABLE_SHARE);
	if (available >= least) return undefined;
	const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
	return `${gb(available)} GB of memory was available, under ${gb(least)} GB`;
}

/** One round's reading of its machine's room, asked at each look. */
export interface RoundRoom {
	/** What keeps the round from starting now, or nothing. */
	short(): Promise<string | undefined>;
	/** Why the round started though its room couldn't be judged, if it did. */
	startedUnjudged(): string | undefined;
}

/** A Mac's figures, dated when read, with the swap history they joined. */
export interface MacReading {
	readonly at: number;
	readonly figures: MemoryFigures;
	/** The readings the swap rule compares against, this one last. */
	readonly seen: readonly Swapped[];
}

/** Since when the rounds of this process have had no verdict on the Mac. */
export interface UnjudgedSince {
	since: number | undefined;
}

/** Where a round's reading of a Mac, the time and its process's wait come from. */
export interface MacSources {
	readonly reading: () => Promise<MacReading>;
	readonly clock: () => number;
	readonly unjudged: UnjudgedSince;
}

/**
 * A round's room on a Mac, read by the queue's rule over the swap
 * history every session there shares. A Mac that reads short holds the
 * round as long as it stays short, as Linux does. One whose room can't
 * be judged, its figures unread or no reading a minute old, holds the
 * rounds of this process for {@link UNJUDGED_WAIT_MS} in all, after which
 * they start and say why; any verdict starts that wait again.
 */
export function macRoundRoom(sources: MacSources = thisMac()): RoundRoom {
	let startedUnjudged: string | undefined;
	return {
		short: async () => {
			const read = await readingOf(sources.reading);
			const now = sources.clock();
			const verdict = typeof read === "string" ? undefined : judged(read);
			if (verdict !== undefined) {
				sources.unjudged.since = undefined;
				startedUnjudged = undefined;
				return verdict.short;
			}
			const why =
				typeof read === "string"
					? `this Mac's memory can't be read (${read})`
					: "this Mac waits for a reading a minute old, to see whether it swaps";
			sources.unjudged.since ??= now;
			if (now - sources.unjudged.since < UNJUDGED_WAIT_MS) return why;
			startedUnjudged = `It started though this Mac's room couldn't be judged for ${UNJUDGED_WAIT_MS / 60_000} minutes: ${why}.`;
			return undefined;
		},
		startedUnjudged: () => startedUnjudged,
	};
}

/**
 * The rule's verdict on a reading, or undefined when it can't give one:
 * the swap rule needs a reading a minute old to compare against, unless
 * pressure or a short share already says short.
 */
function judged(read: MacReading): { short: string | undefined } | undefined {
	const short = darwinShort(read.figures, read.seen);
	if (short !== undefined) return { short };
	const oldest = read.seen[0];
	return oldest !== undefined && read.at - oldest.at >= SWAPPING_MS
		? { short: undefined }
		: undefined;
}

/** The reading, or why it can't be had. */
async function readingOf(
	reading: () => Promise<MacReading>,
): Promise<MacReading | string> {
	let read: MacReading;
	try {
		read = await reading();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const unread = (
		["availablePercent", "pressureLevel", "swapouts"] as const
	).filter((name) => !Number.isFinite(read.figures[name]));
	return unread.length === 0 ? read : `no figure for ${unread.join(", ")}`;
}

/**
 * The figures from `sysctl`'s and `vm_stat`'s answers, a figure neither
 * names read as NaN, so a lost count is told from none.
 */
export function macFiguresFrom(sysctl: string, vmStat: string): MemoryFigures {
	const values = sysctlValues(sysctl);
	const number = (name: string) => Number(values.get(name) ?? Number.NaN);
	return {
		availablePercent: number("kern.memorystatus_level"),
		pressureLevel: number("kern.memorystatus_vm_pressure_level"),
		swapouts: swapoutsReadIn(vmStat) ?? Number.NaN,
	};
}

const run = promisify(execFile);

/**
 * What this Mac's kernel says now, asked of `sysctl` and `vm_stat` at
 * once and off the main thread, as a Mac short of memory answers slowly.
 */
export async function macFiguresNow(): Promise<MemoryFigures> {
	const options = { encoding: "utf8", timeout: PROGRAM_TIMEOUT_MS } as const;
	const [sysctl, vmStat] = await Promise.all([
		run(
			"sysctl",
			["kern.memorystatus_level", "kern.memorystatus_vm_pressure_level"],
			options,
		),
		run("vm_stat", [], options),
	]);
	return macFiguresFrom(sysctl.stdout, vmStat.stdout);
}

/**
 * One reading of the Mac at a time for every round in this process,
 * read again once it is {@link MAC_READING_SERVES_MS} old and dated once
 * read. A failure serves as long, so a Mac that can't answer is asked
 * no more often than one that can. Each reading joins `history`, which
 * every session there shares with the queue.
 */
export function sharedReading(
	figures: () => Promise<MemoryFigures>,
	clock: () => number,
	history: SwapHistory,
): () => Promise<MacReading> {
	let kept: { done?: number; reading: Promise<MacReading> } | undefined;
	return () => {
		const done = kept?.done;
		if (
			kept === undefined ||
			(done !== undefined && clock() - done >= MAC_READING_SERVES_MS)
		) {
			const next: { done?: number; reading: Promise<MacReading> } = {
				reading: figures().then(
					(read) => {
						const at = clock();
						next.done = at;
						const seen = Number.isFinite(read.swapouts)
							? keptAt(history.load(), { at, swapouts: read.swapouts })
							: [];
						if (seen.length > 0) history.save(seen);
						return { at, figures: read, seen };
					},
					(error: unknown) => {
						next.done = clock();
						throw error;
					},
				),
			};
			// Every caller awaits the reading; this keeps a failure no round
			// has asked for yet from reading as unhandled.
			next.reading.catch(() => undefined);
			kept = next;
		}
		return kept.reading;
	};
}

/** The history the queue keeps beside its locks, which every session reads. */
const SHARED_HISTORY = historyIn(() => {
	const queue = machineQueueDir();
	return queue === undefined ? undefined : join(queue, LOCK_FOLDER);
});

const THIS_MAC = sharedReading(macFiguresNow, Date.now, SHARED_HISTORY);
const THIS_MAC_UNJUDGED: UnjudgedSince = { since: undefined };

function thisMac(): MacSources {
	return { reading: THIS_MAC, clock: Date.now, unjudged: THIS_MAC_UNJUDGED };
}
