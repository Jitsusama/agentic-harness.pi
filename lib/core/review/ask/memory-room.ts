/**
 * Whether the machine has the memory to start a council's reviewers.
 *
 * A council starts several pis at once, each holding a pi's worth of
 * memory for minutes. Rounds used to start a fixed three minutes apart
 * whatever the machine had to spare, so on 24 November one waited about
 * 30 minutes behind ten others on a machine with room for all of them,
 * and on a starved one three minutes was no guard at all. The rule now
 * is room alone (1OGSE7, 24 November): on Linux a round starts while the
 * share of the last minute every task spent stalled on memory, the
 * kernel's `full avg60`, is under 10.
 *
 * A Mac keeps no such file, and until 25 November its line read that as
 * room and started rounds blind. Its bar is velocity's (A210E4CA, 25
 * November): a round starts while the kernel says at least 35% of memory
 * is free, the figure `memory_pressure` prints, and no page has been
 * swapped out over the last minute. A Mac whose figures can't be read is
 * short, not roomy, since that is where blind starts did the harm.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** The kernel's memory pressure, where Linux keeps it. */
export const MEMORY_PRESSURE_FILE = "/proc/pressure/memory";

/** The `full avg60` at and past which a round waits for room. */
export const FULL_AVG60_AT_MOST = 10;

/** The share of a Mac's memory free, in percent, a round starts at. */
export const MAC_FREE_PERCENT_AT_LEAST = 35;

/** How long a Mac's swap-outs must hold still before a round starts. */
export const SWAP_STILL_MS = 60_000;

/** How long a Mac's reading may take before it counts as unread. */
const MAC_READ_TIMEOUT_MS = 5000;

const FULL_AVG60 = /^full\b.*\bavg60=(\d+(?:\.\d+)?)/m;
const SWAPOUTS = /^Swapouts:\s+(\d+)\./m;
const PERCENT = /^\s*(\d+)\s*$/;

/** What a Mac says of its memory at one reading. */
export interface MacMemory {
	/** The share of memory free, in percent, as the kernel judges it. */
	readonly freePercent: number;
	/** Pages swapped out since the Mac started. */
	readonly swapouts: number;
}

/**
 * What keeps a round from starting now, said for its answer, or nothing
 * when the machine has room: on a Mac by {@link macMemoryShort}, on
 * Linux by its pressure file. A Linux with no pressure file, as an old
 * kernel, or one whose reading can't be had, has room: nothing says
 * otherwise, and a round held on a reading that never comes would never
 * start.
 */
export async function memoryShort(
	read: () => Promise<string> = () => readFile(MEMORY_PRESSURE_FILE, "utf8"),
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	if (platform === "darwin") {
		return await macMemoryShort(readMacMemory, THIS_MAC, Date.now());
	}
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

/**
 * The swap-out counts a process has read off its Mac, each with when,
 * so a look can say whether they moved over the last minute.
 */
export interface SwapWatch {
	readings: { at: number; swapouts: number }[];
}

/** A watch that has read nothing yet. */
export function swapWatch(): SwapWatch {
	return { readings: [] };
}

/** This process's watch of its Mac's swap-outs. */
const THIS_MAC = swapWatch();

/**
 * What keeps a round from starting on a Mac now, or nothing when it has
 * room: at least {@link MAC_FREE_PERCENT_AT_LEAST}% free and no swap-out
 * since a reading at least {@link SWAP_STILL_MS} old. A process that has
 * watched for less than that is short until it has, so its first round
 * waits a minute; one whose figures can't be read is short.
 */
export async function macMemoryShort(
	read: () => Promise<MacMemory>,
	watch: SwapWatch,
	now: number,
): Promise<string | undefined> {
	let memory: MacMemory;
	try {
		memory = await read();
	} catch (error) {
		return `this Mac's memory couldn't be read (${String(error)}), so no round starts blind`;
	}
	watch.readings.push({ at: now, swapouts: memory.swapouts });
	// Keep the newest reading a minute old or older, and all since.
	const old = watch.readings.filter((each) => each.at <= now - SWAP_STILL_MS);
	const since = old.at(-1);
	watch.readings = watch.readings.filter(
		(each) => each === since || each.at > now - SWAP_STILL_MS,
	);
	if (memory.freePercent < MAC_FREE_PERCENT_AT_LEAST) {
		return `this Mac had ${memory.freePercent}% of memory free, under ${MAC_FREE_PERCENT_AT_LEAST}%`;
	}
	if (since === undefined) {
		return `this Mac's swap-outs haven't yet been watched for ${SWAP_STILL_MS / 1000} s`;
	}
	if (memory.swapouts !== since.swapouts) {
		return `this Mac swapped out ${memory.swapouts - since.swapouts} pages in the last ${Math.round((now - since.at) / 1000)} s`;
	}
	return undefined;
}

/**
 * Reads a Mac's memory: the free share `sysctl` keeps, which is what
 * `memory_pressure` prints without sampling, and `vm_stat`'s swap-outs.
 * Throws when either can't be read or says what it isn't meant to.
 */
export async function readMacMemory(): Promise<MacMemory> {
	const run = promisify(execFile);
	const options = { timeout: MAC_READ_TIMEOUT_MS };
	const [level, stat] = await Promise.all([
		run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"], options),
		run("/usr/bin/vm_stat", [], options),
	]);
	return parseMacMemory(level.stdout, stat.stdout);
}

/**
 * The memory `sysctl -n kern.memorystatus_level` and `vm_stat` printed,
 * read; throws when either holds no figure where it should.
 */
export function parseMacMemory(level: string, vmStat: string): MacMemory {
	const free = PERCENT.exec(level)?.[1];
	if (free === undefined) {
		throw new Error(`kern.memorystatus_level said ${JSON.stringify(level)}`);
	}
	const swapouts = SWAPOUTS.exec(vmStat)?.[1];
	if (swapouts === undefined) throw new Error("vm_stat named no Swapouts");
	return { freePercent: Number(free), swapouts: Number(swapouts) };
}
