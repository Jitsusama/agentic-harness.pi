/**
 * How much room the machine has left, read from the kernel.
 *
 * Memory available is the kernel's own MemAvailable, less what the
 * memory floors core.nix sets keep for the programs under them. A floor
 * (memory.min) protects everything a cgroup holds up to it, its page
 * cache too, but MemAvailable counts that cache as free; so a floor
 * keeps all of itself but the memory its programs hold as their own
 * (anon), which MemAvailable already leaves out. With session.slice's
 * 1 GiB floor holding 116 MiB anon and 329 MiB cache, that is 908 MiB
 * kept, where the floor less what it holds would say 564; it errs a
 * little safe. Only the innermost floors count, since an outer
 * one (user.slice's 15%) holds the inner ones (app.slice's 13%) and the
 * work itself. They are read from the cgroups, not worked out again.
 *
 * Memory is also no more than the swap left. A job's heap that has gone
 * cold is swapped out and MemAvailable recovers, though the job still
 * holds it: four flake checks' evaluators held about 80 GiB on 23
 * October, mostly in swap, while MemAvailable read 17 GiB free with
 * swap 86% full. A new job's memory then has nowhere to push what it
 * displaces. So on a machine with swap, the room is the smaller of the
 * two; with swap mostly free, as it usually is, that changes nothing.
 *
 * VMs are counted by their processes' names, whoever runs them: the
 * Nix daemon's build users run a VM check's qemu, and the name is all
 * that another user's process shows. A whole reading took 3.9 ms over
 * 767 processes on optimus, every 2 seconds while jobs stand.
 *
 * A check with deadlines counts as one VM whatever it runs its machine
 * on, since load breaks its timing the same way: a Nix build running
 * NixOS's test driver, systemd-nspawn, niri or sway, with no qemu of its
 * own to be counted by, in the build's cgroup or its containers'. Only
 * the daemon's builds are looked in, so Joel's own niri never counts.
 * It is read from what runs rather than from the check's name, which
 * says what a check proves, not where it runs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "./queue.ts";

const GIB = 1024 ** 3;

/** What the machine has left, and how hard it is working for it. */
export interface Reading extends Room {
	readonly cores: number;
	readonly pressure: {
		readonly cpu: number;
		readonly memory: number;
		readonly io: number;
	};
}

/** Where the kernel's files are, so a test can stand in for them. */
export interface Kernel {
	readonly proc: string;
	readonly cgroups: string;
}

export const KERNEL: Kernel = { proc: "/proc", cgroups: "/sys/fs/cgroup" };

/** How deep floors are looked for: user.slice/user-N/user@N/app.slice. */
const FLOOR_DEPTH = 5;

/** The innermost cgroups with a memory floor, by path. */
export function floorsIn(cgroups: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number): boolean => {
		let below = false;
		if (depth < FLOOR_DEPTH) {
			for (const entry of entries(dir)) {
				if (walk(join(dir, entry), depth + 1)) below = true;
			}
		}
		if (below) return true;
		if (depth > 0 && number(join(dir, "memory.min")) > 0) {
			found.push(dir);
			return true;
		}
		return false;
	};
	walk(cgroups, 0);
	return found.sort();
}

/** The machine's room now, given the floors to count. */
export function readRoom(
	floors: readonly string[],
	kernel: Kernel = KERNEL,
): Reading {
	const swap = swapFree(kernel.proc);
	const available = Math.min(memAvailable(kernel.proc), swap ?? Infinity);
	const kept = floors.reduce(
		(sum, floor) =>
			sum + Math.max(0, number(join(floor, "memory.min")) - anonIn(floor)),
		0,
	);
	const memory = pressure(kernel.proc, "memory");
	const cpu = pressure(kernel.proc, "cpu");
	return {
		availableGib: Math.max(0, available - kept) / GIB,
		memoryPressure: memory,
		vms: vmsIn(kernel.proc) + timedBuildsIn(kernel),
		cpuPressure: cpu,
		cores: cores(kernel.proc),
		pressure: {
			cpu,
			memory,
			io: pressure(kernel.proc, "io"),
		},
	};
}

/** Whether a process is still running. */
export function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The cgroup a process runs in, as /proc says, if it still runs. */
export function cgroupOf(
	pid: number,
	proc: string = KERNEL.proc,
): string | undefined {
	const line = text(join(proc, String(pid), "cgroup"))
		.split("\n")
		.find((entry) => entry.startsWith("0::"));
	return line ? line.slice(3) : undefined;
}

/** The memory a cgroup's programs hold as their own, from memory.stat. */
function anonIn(cgroup: string): number {
	const anon = /^anon (\d+)$/m.exec(text(join(cgroup, "memory.stat")));
	return anon ? Number(anon[1]) : 0;
}

function memAvailable(proc: string): number {
	return meminfo(proc, "MemAvailable") ?? 0;
}

/** The swap left, in bytes, or undefined on a machine with none. */
function swapFree(proc: string): number | undefined {
	const total = meminfo(proc, "SwapTotal") ?? 0;
	return total > 0 ? (meminfo(proc, "SwapFree") ?? 0) : undefined;
}

/** One field of /proc/meminfo, in bytes. */
function meminfo(proc: string, field: string): number | undefined {
	const line = text(join(proc, "meminfo"))
		.split("\n")
		.find((entry) => entry.startsWith(`${field}:`));
	const kib = Number(line?.split(/\s+/)[1]);
	return Number.isFinite(kib) ? kib * 1024 : undefined;
}

/** The share of time some task stalled, avg10, in percent. */
function pressure(proc: string, kind: string): number {
	const some = /^some avg10=([\d.]+)/m.exec(text(join(proc, "pressure", kind)));
	return some ? Number(some[1]) : 0;
}

/** A VM's process name, cut to the kernel's 15 characters. */
const VM_PROCESS = /^qemu-(?:system-|kvm)/;

/** How many VMs run on the machine, by their processes' names. */
function vmsIn(proc: string): number {
	let count = 0;
	for (const entry of names(proc)) {
		if (!/^\d+$/.test(entry)) continue;
		if (VM_PROCESS.test(text(join(proc, entry, "comm")))) count += 1;
	}
	return count;
}

/** Where the Nix daemon makes a cgroup for each build. */
const BUILDS = "build.slice/nix-daemon.service";

/**
 * What runs in a check with deadlines, besides a VM's qemu: a name
 * ending in `*` by what a process's name starts with, any other whole,
 * since cargo names a niri build's own test programs `niri-<hash>`.
 */
const TIMED = ["nixos-test-driver*", "systemd-nspawn*", "niri", "sway"];

/** The longest name the kernel keeps for a process. */
const COMM_LENGTH = 15;

/**
 * Whether a process's name is one in {@link TIMED}. Nix's wrapped
 * programs start with a dot, and the kernel cuts a name at 15
 * characters, so `.nixos-test-dri` is the test driver. A whole name
 * matches only itself, or Nix's wrapper of it, as `.niri-wrapped` is.
 */
function isTimed(comm: string): boolean {
	const cut = comm.length === COMM_LENGTH;
	const bare = comm.startsWith(".") ? comm.slice(1) : comm;
	return TIMED.some((name) => {
		if (!name.endsWith("*")) return bare === name || bare === `${name}-wrapped`;
		const prefix = name.slice(0, -1);
		return bare.startsWith(prefix) || (cut && prefix.startsWith(bare));
	});
}

/** How many Nix builds run a check with deadlines but no qemu. */
function timedBuildsIn(kernel: Kernel): number {
	const daemon = join(kernel.cgroups, BUILDS);
	let count = 0;
	for (const build of entries(daemon)) {
		if (!build.startsWith("nix-build-")) continue;
		const comms = pidsUnder(join(daemon, build)).map((pid) =>
			text(join(kernel.proc, pid, "comm")).trim(),
		);
		if (comms.some((comm) => VM_PROCESS.test(comm))) continue;
		if (comms.some(isTimed)) count += 1;
	}
	return count;
}

/** Every process in a cgroup and the cgroups under it. */
function pidsUnder(cgroup: string): string[] {
	const own = text(join(cgroup, "cgroup.procs"))
		.split("\n")
		.filter((pid) => /^\d+$/.test(pid));
	return [
		...own,
		...entries(cgroup).flatMap((child) => pidsUnder(join(cgroup, child))),
	];
}

function names(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function cores(proc: string): number {
	return (text(join(proc, "cpuinfo")).match(/^processor\s*:/gm) ?? []).length;
}

function number(path: string): number {
	const value = Number(text(path).trim());
	return Number.isFinite(value) ? value : 0;
}

function text(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function entries(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}
