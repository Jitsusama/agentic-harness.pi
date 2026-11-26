/**
 * Whether the machine has the memory to start a council's reviewers.
 *
 * A council starts several pis at once, each holding a pi's worth of
 * memory for minutes. Rounds used to start a fixed three minutes apart
 * whatever the machine had to spare, so on 24 November one waited about
 * 30 minutes behind ten others on a machine with room for all of them,
 * and on a starved one three minutes was no guard at all. The rule now
 * is room alone (1OGSE7, 24 November): a round starts while the share
 * of the last minute every task spent stalled on memory, the kernel's
 * `full avg60`, is under 10.
 *
 * A Mac keeps no such figure, so it reads the rule the machine queue
 * reads there (room-darwin.ts): the kernel's pressure level, a swap-out
 * within the last minute, or too little memory available. On 25
 * November a Mac swapped hard while rounds still started on it, as the
 * Linux rule read a missing file as room, and Joel's window froze.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	LOCK_FOLDER,
	machineQueueDir,
} from "../../../internal/priority/folder.ts";
import {
	type DarwinFacts,
	darwinFactsNow,
	darwinShort,
	historyIn,
	keptAt,
	SWAPPING_MS,
	type SwapHistory,
} from "../../../internal/priority/room-darwin.ts";

/** The kernel's memory pressure, where Linux keeps it. */
export const MEMORY_PRESSURE_FILE = "/proc/pressure/memory";

/** The `full avg60` at and past which a round waits for room. */
export const FULL_AVG60_AT_MOST = 10;

/**
 * How long a round waits on a Mac whose memory can't be read before it
 * starts anyway, saying so: a reading that never comes must not hold a
 * round for ever, and a quarter of an hour is the longest velocity lets
 * a round wait (A210E4CA, 26 November).
 */
export const UNREAD_WAIT_MS = 15 * 60_000;

/**
 * How long one reading of a Mac serves every round in this process:
 * `sysctl`, `vm_stat` and `ps` run each time, and rounds look every 15 s.
 */
export const MAC_READING_SERVES_MS = 10_000;

const FULL_AVG60 = /^full\b.*\bavg60=(\d+(?:\.\d+)?)/m;

/**
 * What keeps a round from starting now, said for its answer, or nothing
 * when the machine has room. A machine that keeps no pressure file, or
 * one whose reading can't be had, has room by this rule: a Mac reads
 * {@link macRoundRoom} instead.
 */
export async function memoryShort(
	read: () => Promise<string> = () => readFile(MEMORY_PRESSURE_FILE, "utf8"),
): Promise<string | undefined> {
	let text: string;
	try {
		text = await read();
	} catch {
		// No pressure file, as on an old kernel: nothing says short.
		return undefined;
	}
	const said = FULL_AVG60.exec(text)?.[1];
	if (said === undefined) return undefined;
	const avg60 = Number(said);
	return avg60 < FULL_AVG60_AT_MOST
		? undefined
		: `memory full avg60 was ${avg60}, at or past ${FULL_AVG60_AT_MOST}`;
}

/** One round's reading of its machine's room, asked at each look. */
export interface RoundRoom {
	/** What keeps the round from starting now, or nothing. */
	short(): Promise<string | undefined>;
	/** Why the round started though its room couldn't be read, if it did. */
	startedUnread(): string | undefined;
}

/** A Mac's figures, dated when they were read. */
export interface DatedFacts {
	readonly at: number;
	readonly facts: DarwinFacts;
}

/** Where a Mac's figures, the time and the shared swap history come from. */
export interface MacSources {
	readonly reading: () => DatedFacts;
	readonly clock: () => number;
	readonly history: SwapHistory;
}

/**
 * A round's room on a Mac, read by the queue's rule over the swap
 * history every session there shares. Figures that can't be read keep
 * the round waiting for at most {@link UNREAD_WAIT_MS}, after which it
 * starts and says why.
 */
export function macRoundRoom(sources: MacSources = thisMac()): RoundRoom {
	let unreadSince: number | undefined;
	let unreadWhy: string | undefined;
	let startedUnread: string | undefined;
	return {
		short: async () => {
			const now = sources.clock();
			const dated = readingOf(sources.reading);
			if (typeof dated === "string") {
				const read = dated;
				unreadSince ??= now;
				unreadWhy = read;
				if (now - unreadSince < UNREAD_WAIT_MS) {
					return `this Mac's memory can't be read (${read})`;
				}
				startedUnread = `It started though this Mac's memory couldn't be read for ${UNREAD_WAIT_MS / 60_000} minutes (${unreadWhy}).`;
				return undefined;
			}
			unreadSince = undefined;
			startedUnread = undefined;
			const { at, facts } = dated;
			const seen = keptAt(sources.history.load(), {
				at,
				swapouts: facts.swapouts,
			});
			sources.history.save(seen);
			const short = darwinShort(facts, seen);
			if (short !== undefined) return short;
			const oldest = seen[0];
			return oldest !== undefined && at - oldest.at >= SWAPPING_MS
				? undefined
				: "this Mac waits for a reading a minute old, to see whether it swaps";
		},
		startedUnread: () => startedUnread,
	};
}

/** The dated facts, or why they can't be had. */
function readingOf(reading: () => DatedFacts): DatedFacts | string {
	let dated: DatedFacts;
	try {
		dated = reading();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const unread = (
		["availablePercent", "pressureLevel", "swapouts"] as const
	).filter((name) => !Number.isFinite(dated.facts[name]));
	return unread.length === 0 ? dated : `no figure for ${unread.join(", ")}`;
}

/**
 * One reading of the Mac at a time for every round in this process,
 * read again once it is {@link MAC_READING_SERVES_MS} old, and dated
 * once read, as `vm_stat` can take a while on a Mac that swaps. A
 * reading that throws is not kept, so the next look asks again.
 */
export function sharedReading(
	facts: () => DarwinFacts,
	clock: () => number,
): () => DatedFacts {
	let kept: DatedFacts | undefined;
	return () => {
		if (kept === undefined || clock() - kept.at >= MAC_READING_SERVES_MS) {
			const read = facts();
			kept = { at: clock(), facts: read };
		}
		return kept;
	};
}

/** The history the queue keeps beside its locks, which every session reads. */
const SHARED_HISTORY = historyIn(() => {
	const queue = machineQueueDir();
	return queue === undefined ? undefined : join(queue, LOCK_FOLDER);
});

const THIS_MAC = sharedReading(darwinFactsNow, Date.now);

function thisMac(): MacSources {
	return { reading: THIS_MAC, clock: Date.now, history: SHARED_HISTORY };
}
