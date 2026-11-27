/**
 * How much room a Mac has left, in the terms the queue's turn rules read
 * on Linux, so both machines answer to the same rules (G9).
 *
 * A Mac has no PSI and no cgroups, so each of the room's figures comes
 * from what the kernel says instead (5FWIUS, 29 October):
 *
 * - Memory pressure is the kernel's own verdict,
 *   `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4
 *   critical. Warning or worse reads as past the queue's limit, and so
 *   does swapping out across the last minute, the nearest a Mac has to
 *   PSI's stall (velocity's Mac line, 25 November).
 * - Swapping is read from one history the whole machine keeps, not one
 *   a session keeps: every session ticks, but a tick reads the machine
 *   only in the session that claims the reading (reading-claim.ts), and
 *   otherwise only as a tool call checks its own start. With thirty
 *   sessions, each reads about once a minute, so a history of its own
 *   could hold no two readings inside the window and never see a
 *   swap-out. On 25
 *   November at 10:06 the Mac swapped hard while suites still started,
 *   and Joel's window froze.
 *   `vm.swapusage`'s free figure isn't read: macOS drops swap files as
 *   they empty, so it reads short just as the Mac recovers.
 * - Memory available is `kern.memorystatus_level`, the share of memory
 *   the kernel counts as available (free, inactive and purgeable), times
 *   the machine's memory. macOS fills memory with file cache, so that
 *   share falls long before anything waits: it holds work back only
 *   once it is under {@link LEAST_AVAILABLE_PERCENT}, the share under
 *   which velocity found a Mac's window stalling.
 * - CPU pressure is how far the load average runs past the cores, as the
 *   share of runnable work that has to wait, which reads as PSI's
 *   "some" does: nothing until every core is busy.
 * - VMs are the guests running, by their processes' names: a
 *   Virtualization.framework guest, as nix-darwin's Linux builder runs,
 *   or qemu. A guest keeps every page it has touched until it stops, and
 *   the memory reading counts those pages as taken already.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeWhole } from "../write-whole.ts";
import { MOST_MEMORY_PRESSURE } from "./queue.ts";
import type { Reading } from "./room.ts";

const GIB = 1024 ** 3;

/** Under this share of memory available, work waits whatever the pressure. */
export const LEAST_AVAILABLE_PERCENT = 35;

/** How far back a swap-out still counts as the machine swapping now. */
export const SWAPPING_MS = 60_000;

/**
 * How old a reading may be and still date the window's start, when
 * none came just as it began: past this, a swap-out since may be long
 * over, so it says nothing of now.
 */
export const BASELINE_MS = 2 * SWAPPING_MS;

/**
 * The file that keeps the machine's swap-outs, in the queue's lock
 * folder, which the desktop's watch on the queue's folder doesn't hear.
 */
export const SWAP_FILE = "swapouts.json";

/** The kernel's pressure level from which work waits: warning. */
const WARNING_LEVEL = 2;

/** Process names of a VM guest running here. */
const GUESTS = [
	/^com\.apple\.Virtualization\.VirtualMachine$/,
	/(?:^|\/)qemu-system-[\w-]+$/,
];

/** What a Mac's kernel says, read at one moment. */
export interface DarwinFacts {
	readonly memsize: number;
	readonly cores: number;
	/** `kern.memorystatus_level`, percent. */
	readonly availablePercent: number;
	/** `kern.memorystatus_vm_pressure_level`: 1, 2 or 4. */
	readonly pressureLevel: number;
	/** The one-minute load average. */
	readonly load: number;
	/** `vm_stat`'s running count of pages swapped out. */
	readonly swapouts: number;
	/** The VM guests running. */
	readonly guests: number;
}

/** `vm_stat`'s count of swap-outs, as read at one moment. */
export interface Swapped {
	readonly at: number;
	readonly swapouts: number;
}

/** Where the swap-outs read lately are kept between readings. */
export interface SwapHistory {
	load(): readonly Swapped[];
	save(seen: readonly Swapped[]): void;
}

/** A history this process alone keeps. */
export function historyInMemory(): SwapHistory {
	let kept: readonly Swapped[] = [];
	return {
		load: () => kept,
		save: (seen) => {
			kept = seen;
		},
	};
}

/**
 * A history every session on the machine shares, kept in the folder
 * `folder` names, asked again on each reading until it names one, so a
 * session that couldn't name it as it loaded still joins the others.
 * Each session also keeps what it saved itself, so a file it can't read
 * or write, or another session's save landing over its own, still leaves
 * its own readings. Two saves at once keep only one file, which costs
 * the other's newest reading, never an older one that dates a swap-out:
 * the count only grows, so any later reading sees it too.
 */
export function historyIn(folder: () => string | undefined): SwapHistory {
	const own = historyInMemory();
	let named: string | undefined;
	const file = (): string | undefined => {
		named ??= folder();
		return named === undefined ? undefined : join(named, SWAP_FILE);
	};
	return {
		load: () => {
			const kept = file();
			return kept === undefined
				? own.load()
				: together(readSwaps(kept), own.load());
		},
		save: (seen) => {
			own.save(seen);
			const kept = file();
			if (kept === undefined) return;
			try {
				writeWhole(kept, JSON.stringify(seen));
			} catch {
				// A history that can't be kept this time is kept on the next,
				// and this session's own readings stand meanwhile.
			}
		},
	};
}

function readSwaps(file: string): readonly Swapped[] {
	try {
		const kept: unknown = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(kept) ? kept.filter(isSwapped) : [];
	} catch {
		// None kept yet, or one half written: this reading starts it.
		return [];
	}
}

/** Both lists' readings, each once. */
function together(
	first: readonly Swapped[],
	second: readonly Swapped[],
): readonly Swapped[] {
	const seen = new Map<string, Swapped>();
	for (const read of [...first, ...second])
		seen.set(`${read.at}:${read.swapouts}`, read);
	return [...seen.values()];
}

function isSwapped(value: unknown): value is Swapped {
	return (
		typeof value === "object" &&
		value !== null &&
		"at" in value &&
		typeof value.at === "number" &&
		"swapouts" in value &&
		typeof value.swapouts === "number"
	);
}

/**
 * The readings worth keeping at `now`, the newest last: those inside the
 * window, and the newest before it while it is young enough to date the
 * window's start. A count above the newest is a boot ago, and goes.
 */
export function keptAt(
	seen: readonly Swapped[],
	newest: Swapped,
): readonly Swapped[] {
	const since = newest.at - SWAPPING_MS;
	const ours = seen.filter(
		(read) =>
			read.at <= newest.at &&
			read.at >= newest.at - BASELINE_MS &&
			read.swapouts <= newest.swapouts,
	);
	const before = ours.filter((read) => read.at < since).at(-1);
	const inside = ours.filter((read) => read.at >= since);
	return [...(before ? [before] : []), ...inside, newest].sort(
		(a, b) => a.at - b.at,
	);
}

/** The value of each `name: value` line of `sysctl` given names. */
export function sysctlValues(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of text.split("\n")) {
		const at = line.indexOf(":");
		if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
	}
	return values;
}

/**
 * `vm_stat`'s count of pages swapped out, or undefined when no line
 * names one, so a lost count is never read as none.
 */
export function swapoutsReadIn(vmStat: string): number | undefined {
	const found = vmStat.match(/^Swapouts:\s+(\d+)\.?\s*$/m);
	return found ? Number(found[1]) : undefined;
}

/** How many VM guests a list of process names holds. */
export function guestsIn(names: readonly string[]): number {
	return names.filter((name) => GUESTS.some((guest) => guest.test(name.trim())))
		.length;
}

/** The facts from `sysctl`'s, `vm_stat`'s and `ps`'s answers. */
export function darwinFactsFrom(
	sysctl: string,
	vmStat: string,
	processNames: readonly string[],
): DarwinFacts {
	const values = sysctlValues(sysctl);
	const number = (name: string) => Number(values.get(name) ?? Number.NaN);
	const load = Number(
		(values.get("vm.loadavg") ?? "")
			.replace(/[{}]/g, "")
			.trim()
			.split(/\s+/)[0],
	);
	return {
		memsize: number("hw.memsize"),
		cores: number("hw.ncpu"),
		availablePercent: number("kern.memorystatus_level"),
		pressureLevel: number("kern.memorystatus_vm_pressure_level"),
		load,
		// NaN when vm_stat named none, so a lost count never joins the
		// shared history as 0 and reads to a council's start as a swap.
		swapouts: swapoutsReadIn(vmStat) ?? Number.NaN,
		guests: guestsIn(processNames),
	};
}

/** What the kernel says now, asked of `sysctl`, `vm_stat` and `ps`. */
export function darwinFactsNow(): DarwinFacts {
	const run = (program: string, args: readonly string[]) =>
		execFileSync(program, args, {
			encoding: "utf8",
			timeout: 2_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
	return darwinFactsFrom(
		run("sysctl", [
			"hw.memsize",
			"hw.ncpu",
			"kern.memorystatus_level",
			"kern.memorystatus_vm_pressure_level",
			"vm.loadavg",
		]),
		run("vm_stat", []),
		run("ps", ["-axo", "comm="]).split("\n"),
	);
}

/** The figures {@link darwinShort} judges a Mac's memory by. */
export type MemoryFigures = Pick<
	DarwinFacts,
	"availablePercent" | "pressureLevel" | "swapouts"
>;

/**
 * What holds work back on a Mac read as `read`, said for a person, or
 * nothing when it has room: the kernel's pressure at warning or worse,
 * a swap-out since the oldest of `seen`, the readings {@link keptAt}
 * keeps, or less available than {@link LEAST_AVAILABLE_PERCENT}. The
 * queue and a council's start read the one rule.
 */
export function darwinShort(
	read: MemoryFigures,
	seen: readonly Swapped[],
): string | undefined {
	if (read.pressureLevel >= WARNING_LEVEL) {
		return `the kernel's memory pressure level is ${read.pressureLevel}, at or past warning`;
	}
	const since = seen[0];
	if (since !== undefined && read.swapouts > since.swapouts) {
		const newest = seen.at(-1)?.at ?? since.at;
		const seconds = Math.round((newest - since.at) / 1000);
		return `it swapped out ${read.swapouts - since.swapouts} pages in the last ${seconds} s`;
	}
	if (read.availablePercent < LEAST_AVAILABLE_PERCENT) {
		return `${read.availablePercent}% of its memory is available, under ${LEAST_AVAILABLE_PERCENT}%`;
	}
	return undefined;
}

/**
 * Reads a Mac's room as the queue reads a Linux machine's, remembering
 * the last swap-out counts in `history` so that swapping now can be told
 * from swapping long ago.
 */
export function darwinRoom(
	facts: () => DarwinFacts = darwinFactsNow,
	clock: () => number = Date.now,
	history: SwapHistory = historyInMemory(),
): () => Reading {
	return () => {
		// Dated once read, as vm_stat can take a while on a Mac that swaps.
		const read = facts();
		const now = clock();
		const seen = Number.isFinite(read.swapouts)
			? keptAt(history.load(), { at: now, swapouts: read.swapouts })
			: history.load();
		if (Number.isFinite(read.swapouts)) history.save(seen);
		const memoryPressure =
			darwinShort(read, seen) === undefined ? 0 : MOST_MEMORY_PRESSURE;
		const waiting =
			read.load > read.cores ? ((read.load - read.cores) / read.load) * 100 : 0;
		const cpuPressure = Math.round(waiting * 100) / 100;
		return {
			availableGib: (read.memsize * read.availablePercent) / 100 / GIB,
			memoryPressure,
			vms: read.guests,
			cpuPressure,
			cores: read.cores,
			pressure: { cpu: cpuPressure, memory: memoryPressure, io: 0 },
		};
	};
}
