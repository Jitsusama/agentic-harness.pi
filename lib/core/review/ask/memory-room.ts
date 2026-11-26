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
import { promisify } from "node:util";
import { SYSCTL_PATH } from "../../../internal/boot-token.ts";
import { machineLockDir } from "../../../internal/priority/folder.ts";
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
 * judge, a figure unread or no reading old enough, before they start
 * anyway and say so. Velocity lets a round wait a quarter of an hour at
 * most for a Mac that can't say (A210E4CA, 26 November), and a round
 * starts a look and a spacing after this, so it is well under that. A
 * Mac that reads short holds a round as long as it stays short, with no
 * cap, as Linux does.
 */
export const UNJUDGED_WAIT_MS = 10 * 60_000;

/**
 * How long one reading of a Mac, or its failure, serves every round in
 * this process: longer than the 15 s a waiting round looks again, so
 * however many rounds a process holds, it runs `sysctl` and `vm_stat`
 * at most once a look, and a lone round every other look.
 */
export const MAC_READING_SERVES_MS = 20_000;

/**
 * How long `sysctl` or `vm_stat` may take before it is stopped and read
 * as a Mac too short to answer.
 */
export const PROGRAM_TIMEOUT_MS = 5_000;

/**
 * How long past its timeout a program's answer is waited for before it
 * counts as timed out anyway, for a child the kill never ends.
 */
const PROGRAM_GRACE_MS = 1_000;

/** Apple's own `vm_stat`, by its path, as {@link SYSCTL_PATH} is. */
export const VM_STAT_PATH = "/usr/bin/vm_stat";

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

/**
 * A Mac's figures as its programs gave them, a figure one didn't give
 * read as NaN, with which programs ran out of time and which failed.
 */
export interface MacFigures extends MemoryFigures {
	/** Programs stopped for taking too long, as a Mac swapping hard does. */
	readonly slow?: readonly string[];
	/** Programs that failed some other way, each with why. */
	readonly failed?: readonly string[];
}

/** A Mac's figures, dated when read, with the swap history they joined. */
export interface MacReading {
	readonly at: number;
	readonly figures: MacFigures;
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
 * round as long as it stays short, as Linux does, and so does one whose
 * `sysctl` or `vm_stat` ran out of time, as a Mac swapping hard makes
 * them. One whose room can't be judged, a figure unread or no reading a
 * minute old, holds the rounds of this process for
 * {@link UNJUDGED_WAIT_MS} in all, after which one starts and says why;
 * a verdict, or a start the cap let through, starts that wait again.
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
					: unjudgedWhy(read);
			sources.unjudged.since ??= now;
			if (now - sources.unjudged.since < UNJUDGED_WAIT_MS) return why;
			// The wait was this start's; the next round waits its own.
			sources.unjudged.since = undefined;
			startedUnjudged = `It started though this Mac's room couldn't be judged for ${UNJUDGED_WAIT_MS / 60_000} minutes: ${why}.`;
			return undefined;
		},
		startedUnjudged: () => startedUnjudged,
	};
}

const FIGURE_NAMES = ["availablePercent", "pressureLevel", "swapouts"] as const;

/** The figures a reading lacks, by name. */
function unread(figures: MemoryFigures): readonly string[] {
	return FIGURE_NAMES.filter((name) => !Number.isFinite(figures[name]));
}

/**
 * The rule's verdict on a reading, or undefined when it can't give one.
 * A program out of time says short, and so does any figure read that
 * says short alone, whatever the others; room needs every figure, and
 * for the swap rule a reading a minute old to compare against.
 */
function judged(read: MacReading): { short: string | undefined } | undefined {
	const slow = read.figures.slow ?? [];
	if (slow.length > 0) {
		return {
			short: `${slow.join(" and ")} took past ${PROGRAM_TIMEOUT_MS / 1000} s to answer, as on a Mac swapping hard`,
		};
	}
	const short = darwinShort(read.figures, read.seen);
	if (short !== undefined) return { short };
	if (unread(read.figures).length > 0) return undefined;
	const oldest = read.seen[0];
	return oldest !== undefined && read.at - oldest.at >= SWAPPING_MS
		? { short: undefined }
		: undefined;
}

/** Why a reading that was had gives no verdict. */
function unjudgedWhy(read: MacReading): string {
	const lacking = unread(read.figures);
	if (lacking.length === 0) {
		return "this Mac waits for a reading a minute old, to see whether it swaps";
	}
	const failed = read.figures.failed ?? [];
	const said = failed.length > 0 ? `: ${failed.join("; ")}` : "";
	return `this Mac's memory can't be read (no figure for ${lacking.join(", ")}${said})`;
}

/** The reading, or why it can't be had. */
async function readingOf(
	reading: () => Promise<MacReading>,
): Promise<MacReading | string> {
	try {
		return await reading();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
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

/** What one program answered, or how it failed to. */
export type ProgramAnswer =
	| { readonly text: string }
	| { readonly slow: true }
	| { readonly failed: string };

/** Runs a program by its path, giving the text it prints. */
export type ProgramRunner = (
	path: string,
	args: readonly string[],
) => Promise<ProgramAnswer>;

/**
 * Runs `path` with a timeout, and with a bound past it for a child the
 * timeout's kill never ends, so a reading always settles.
 */
export const runBounded: ProgramRunner = async (path, args) => {
	let bound: NodeJS.Timeout | undefined;
	const outOfTime = new Promise<ProgramAnswer>((settle) => {
		bound = setTimeout(
			() => settle({ slow: true }),
			PROGRAM_TIMEOUT_MS + PROGRAM_GRACE_MS,
		);
		bound.unref();
	});
	const answered = run(path, [...args], {
		encoding: "utf8",
		timeout: PROGRAM_TIMEOUT_MS,
	}).then(
		({ stdout }): ProgramAnswer => ({ text: stdout }),
		(error: unknown): ProgramAnswer => failureOf(path, error),
	);
	try {
		return await Promise.race([answered, outOfTime]);
	} finally {
		clearTimeout(bound);
	}
};

/** How a program failed: killed by its timeout, or why else. */
function failureOf(path: string, error: unknown): ProgramAnswer {
	if (typeof error === "object" && error !== null) {
		if ("killed" in error && error.killed === true) return { slow: true };
		if ("code" in error && error.code !== undefined) {
			return { failed: `${path} failed (${String(error.code)})` };
		}
	}
	return { failed: `${path} failed` };
}

/**
 * What this Mac's kernel says now, asked of `sysctl` and `vm_stat` at
 * once, by their paths and off the main thread, as a Mac short of
 * memory answers slowly. Each is read apart, so what one says still
 * counts when the other fails.
 */
export async function macFiguresNow(
	runner: ProgramRunner = runBounded,
): Promise<MacFigures> {
	const programs = [
		{
			path: SYSCTL_PATH,
			args: ["kern.memorystatus_level", "kern.memorystatus_vm_pressure_level"],
		},
		{ path: VM_STAT_PATH, args: [] },
	] as const;
	const answers = await Promise.all(
		programs.map(({ path, args }) => runner(path, args)),
	);
	const slow: string[] = [];
	const failed: string[] = [];
	const texts = answers.map((answer, at) => {
		const name = programs[at]?.path.split("/").at(-1) ?? "a program";
		if ("text" in answer) return answer.text;
		if ("slow" in answer) slow.push(name);
		else failed.push(answer.failed);
		return "";
	});
	return {
		...macFiguresFrom(texts[0] ?? "", texts[1] ?? ""),
		...(slow.length > 0 ? { slow } : {}),
		...(failed.length > 0 ? { failed } : {}),
	};
}

/**
 * One reading of the Mac at a time for every round in this process,
 * read again once it is {@link MAC_READING_SERVES_MS} old and dated once
 * read. A failure serves as long, so a Mac that can't answer is asked
 * no more often than one that can. Each reading joins `history`, which
 * every session there shares with the queue.
 */
export function sharedReading(
	figures: () => Promise<MacFigures>,
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
const SHARED_HISTORY = historyIn(() => machineLockDir());

const THIS_MAC = sharedReading(macFiguresNow, Date.now, SHARED_HISTORY);
const THIS_MAC_UNJUDGED: UnjudgedSince = { since: undefined };

function thisMac(): MacSources {
	return { reading: THIS_MAC, clock: Date.now, unjudged: THIS_MAC_UNJUDGED };
}
