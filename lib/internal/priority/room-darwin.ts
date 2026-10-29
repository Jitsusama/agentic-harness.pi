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
 *   does swapping out across the last ten seconds, the nearest a Mac has
 *   to PSI's stall.
 * - Memory available is `kern.memorystatus_level`, the share of memory
 *   the kernel counts as available (free, inactive and purgeable), times
 *   the machine's memory. macOS fills memory with file cache, so that
 *   share falls long before anything waits: it holds work back only
 *   once it is under {@link LEAST_AVAILABLE_PERCENT}.
 * - CPU pressure is how far the load average runs past the cores, as the
 *   share of runnable work that has to wait, which reads as PSI's
 *   "some" does: nothing until every core is busy.
 * - VMs are the guests running, by their processes' names: a
 *   Virtualization.framework guest, as nix-darwin's Linux builder runs,
 *   or qemu. A guest keeps every page it has touched until it stops, and
 *   the memory reading counts those pages as taken already.
 */

import { execFileSync } from "node:child_process";
import { MOST_MEMORY_PRESSURE } from "./queue.ts";
import type { Reading } from "./room.ts";

const GIB = 1024 ** 3;

/** Under this share of memory available, work waits whatever the pressure. */
export const LEAST_AVAILABLE_PERCENT = 20;

/** How far back a swap-out still counts as the machine swapping now. */
export const SWAPPING_MS = 10_000;

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

/** The value of each `name: value` line of `sysctl` given names. */
export function sysctlValues(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of text.split("\n")) {
		const at = line.indexOf(":");
		if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
	}
	return values;
}

/** `vm_stat`'s count of pages swapped out, or 0 when it names none. */
export function swapoutsIn(vmStat: string): number {
	const found = vmStat.match(/^Swapouts:\s+(\d+)\.?\s*$/m);
	return found ? Number(found[1]) : 0;
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
		swapouts: swapoutsIn(vmStat),
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

/**
 * Reads a Mac's room as the queue reads a Linux machine's, remembering
 * the last swap-out counts so that swapping now can be told from
 * swapping long ago.
 */
export function darwinRoom(
	facts: () => DarwinFacts = darwinFactsNow,
	clock: () => number = Date.now,
): () => Reading {
	const seen: { at: number; swapouts: number }[] = [];
	return () => {
		const now = clock();
		const read = facts();
		seen.push({ at: now, swapouts: read.swapouts });
		while (seen.length > 1 && (seen[0]?.at ?? now) < now - SWAPPING_MS) {
			seen.shift();
		}
		const swapping = read.swapouts > (seen[0]?.swapouts ?? read.swapouts);
		const pressed =
			read.pressureLevel >= WARNING_LEVEL ||
			swapping ||
			read.availablePercent < LEAST_AVAILABLE_PERCENT;
		const memoryPressure = pressed ? MOST_MEMORY_PRESSURE : 0;
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
