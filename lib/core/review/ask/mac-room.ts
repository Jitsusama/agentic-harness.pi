/**
 * Whether a Mac has the memory to start a council's reviewers.
 *
 * Linux judges a round's room by its pressure files and `meminfo`
 * (machine-room.ts). A Mac keeps no such figure, so it reads the rule
 * the machine queue reads there (room-darwin.ts): the kernel's pressure
 * level, a swap-out within the last minute, or too little memory
 * available. On 25 November a Mac swapped hard while rounds still
 * started on it, as the Linux rule read a missing file as room, and
 * Joel's window froze.
 */

import { execFile } from "node:child_process";
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
 * How long a wait with no verdict may go unlooked at and still count
 * toward {@link UNJUDGED_WAIT_MS}. A waiting round looks every 15 s, so
 * a longer gap means no round of this process was asking the Mac's
 * memory: none was waiting, or each waited behind a round still
 * running. That wait starts over, so a round that comes or looks again
 * later never starts on the cap at its first look, with no baseline.
 */
export const UNJUDGED_LOOK_GAP_MS = 60_000;

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

/** One round's reading of its machine's room, asked at each look. */
export interface RoundRoom {
	/** What keeps the round from starting now, or nothing. */
	short(): Promise<string | undefined>;
	/**
	 * Why the round started though its room couldn't be judged, if it
	 * did. Asked once the round has taken its start, so an unjudged start
	 * spends its process's wait only then, never at a look that let it
	 * through without its starting.
	 */
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
	/** When a round of this process last looked with no verdict. */
	lastLook?: number | undefined;
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
 * {@link UNJUDGED_WAIT_MS} of looks in all, after which the cap lets a
 * round through and it says why once it starts. A verdict, a start the
 * cap let through, or a gap past {@link UNJUDGED_LOOK_GAP_MS} with no
 * round looking starts that wait again; a look the cap let through
 * whose round didn't start spends nothing, so the next look may start.
 */
export function macRoundRoom(sources: MacSources = thisMac()): RoundRoom {
	const wait = sources.unjudged;
	let letThrough: string | undefined;
	return {
		short: async () => {
			const read = await readingOf(sources.reading);
			const now = sources.clock();
			const verdict = typeof read === "string" ? undefined : judged(read);
			if (verdict !== undefined) {
				wait.since = undefined;
				wait.lastLook = undefined;
				letThrough = undefined;
				return verdict.short;
			}
			const why =
				typeof read === "string"
					? `this Mac's memory can't be read (${read})`
					: unjudgedWhy(read);
			const last = wait.lastLook;
			if (
				wait.since === undefined ||
				last === undefined ||
				now - last > UNJUDGED_LOOK_GAP_MS
			) {
				wait.since = now;
			}
			wait.lastLook = now;
			if (now - wait.since < UNJUDGED_WAIT_MS) {
				letThrough = undefined;
				return why;
			}
			letThrough = `It started though this Mac's room couldn't be judged for ${UNJUDGED_WAIT_MS / 60_000} minutes: ${why}.`;
			return undefined;
		},
		startedUnjudged: () => {
			// The wait was this start's; the next round waits its own.
			if (letThrough !== undefined) {
				wait.since = undefined;
				wait.lastLook = undefined;
			}
			return letThrough;
		},
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
 * A runner that gives `path` `timeoutMs` before it kills it, and
 * answers slow `graceMs` past that for a child the kill can't end
 * yet, as one stuck in the kernel on a swapping Mac, so a reading
 * always settles.
 */
export function boundedRunner(
	timeoutMs: number,
	graceMs: number,
): ProgramRunner {
	return async (path, args) => {
		let bound: NodeJS.Timeout | undefined;
		const outOfTime = new Promise<ProgramAnswer>((settle) => {
			bound = setTimeout(() => settle({ slow: true }), timeoutMs + graceMs);
			bound.unref();
		});
		const answered = run(path, [...args], {
			encoding: "utf8",
			timeout: timeoutMs,
			// A reader stuck on a swapping Mac may sit out a TERM, and the next
			// look would start another beside it; these only read, so KILL.
			killSignal: "SIGKILL",
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
}

/** Runs `path` with the Mac's own timeout and its bound. */
export const runBounded: ProgramRunner = boundedRunner(
	PROGRAM_TIMEOUT_MS,
	PROGRAM_GRACE_MS,
);

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
