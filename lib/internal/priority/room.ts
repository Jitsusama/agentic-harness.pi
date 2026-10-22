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
	const available = memAvailable(kernel.proc);
	const kept = floors.reduce(
		(sum, floor) =>
			sum + Math.max(0, number(join(floor, "memory.min")) - anonIn(floor)),
		0,
	);
	const memory = pressure(kernel.proc, "memory");
	return {
		availableGib: Math.max(0, available - kept) / GIB,
		memoryPressure: memory,
		cores: cores(kernel.proc),
		pressure: {
			cpu: pressure(kernel.proc, "cpu"),
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
	const line = text(join(proc, "meminfo"))
		.split("\n")
		.find((entry) => entry.startsWith("MemAvailable:"));
	const kib = Number(line?.split(/\s+/)[1]);
	return Number.isFinite(kib) ? kib * 1024 : 0;
}

/** The share of time some task stalled, avg10, in percent. */
function pressure(proc: string, kind: string): number {
	const some = /^some avg10=([\d.]+)/m.exec(text(join(proc, "pressure", kind)));
	return some ? Number(some[1]) : 0;
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
