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
 *
 * Memory pressure is as the programs not held at their own limit feel
 * it. A cgroup over its own memory.high is throttled by design and
 * stalls, and a stall counts in every cgroup above it and the machine's
 * figure too: on 26 October a git walk in background.slice, over that
 * slice's 4 GiB, put the machine at 82% stalled while app.slice,
 * session.slice, system.slice and the Nix daemon's builds all read 0,
 * and nine jobs waited on it for twenty minutes with nothing running.
 * A machine short of memory stalls the others too, so it still holds
 * the queue.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MOST_MEMORY_PRESSURE, type Offload, type Room } from "./queue.ts";

const GIB = 1024 ** 3;

/** What the machine has left, and how hard it is working for it. */
export interface Reading extends Room {
	readonly cores: number;
	readonly pressure: {
		readonly cpu: number;
		readonly memory: number;
		readonly io: number;
	};
	/** The Nix builds the daemon runs, on a machine where it is read. */
	readonly builds?: readonly BuildSeen[];
}

/** One Nix build the daemon runs in a cgroup of its own. */
export interface BuildSeen {
	/**
	 * The cgroup of the program that asked the daemon for it, as `nix
	 * build` or `nix flake check` does, while its worker still runs.
	 */
	readonly asker?: string;
	/** Whether it runs a VM or another check with deadlines. */
	readonly timed: boolean;
	/** The most memory it has held, in bytes, from its memory.peak. */
	readonly memoryPeak: number;
}

/** Where the kernel's files are, so a test can stand in for them. */
export interface Kernel {
	readonly proc: string;
	readonly cgroups: string;
	/**
	 * The Nix machines file naming builders elsewhere, which Nix's
	 * `builders = @<file>` reads; absent where none is kept.
	 */
	readonly machines?: string;
	/** The Nix daemon's folder of builder slot locks, where it keeps one. */
	readonly nixLoad?: string;
}

export const KERNEL: Kernel = {
	proc: "/proc",
	cgroups: "/sys/fs/cgroup",
	// Written by 5FWIUS's offload daemon while a builder stands, emptied
	// when it goes.
	machines: "/run/nix-offload/machines",
	nixLoad: "/nix/var/nix/current-load",
};

/** The system the builders' slots are counted for: this machine's. */
const OFFLOAD_SYSTEM = "x86_64-linux";

/** A builder's features, any of which says it can run a VM check. */
const VM_FEATURES: ReadonlySet<string> = new Set(["kvm", "nixos-test"]);

/**
 * The builders' room in a Nix machines file: per line (or `;`-separated
 * entry), `uri systems key maxJobs speedFactor features mandatory
 * hostKey`, `-` for a field left empty. A builder of this machine's
 * system adds its maxJobs to builds, and to VMs too where its features
 * say it runs VMs. Nothing when the file names none.
 *
 * A builder named on several lines counts once, by its largest maxJobs:
 * Nix locks a builder's slots by its URI, so lines that differ only in
 * what they take share one set of slots (5FWIUS, who names the lent
 * builder once for VM tests and once for big builds).
 *
 * Only slots free now count, by `busy`: once every slot of a builder is
 * taken, Nix builds here, so counting a full builder's maxJobs as room
 * let ten VM checks start with its eight slots taken, and five qemu ran
 * here at a 19% memory stall (5FWIUS, 14:27 on 29 October).
 */
export function offloadIn(
	text: string,
	busy: (uri: string, slot: number) => boolean = () => false,
): Offload | undefined {
	const builders = new Map<string, { builds: number; vms: number }>();
	for (const entry of text.split(/[\n;]/)) {
		const fields = entry.replace(/#.*/, "").trim().split(/\s+/);
		const [uri, systems, , jobs, , features] = fields;
		if (!uri) continue;
		if (!(systems ?? "-").split(",").includes(OFFLOAD_SYSTEM)) continue;
		const slots = Number.parseInt(jobs ?? "", 10);
		const count = Number.isFinite(slots) && slots > 0 ? slots : 1;
		const runsVms = (features ?? "-")
			.split(",")
			.some((one) => VM_FEATURES.has(one));
		const seen = builders.get(uri) ?? { builds: 0, vms: 0 };
		builders.set(uri, {
			builds: Math.max(seen.builds, count),
			vms: Math.max(seen.vms, runsVms ? count : 0),
		});
	}
	let builds = 0;
	let vms = 0;
	for (const [uri, one] of builders) {
		const free = (slots: number) =>
			Array.from({ length: slots }, (_, slot) => slot).filter(
				(slot) => !busy(uri, slot),
			).length;
		builds += free(one.builds);
		vms += free(one.vms);
	}
	return builders.size > 0 ? { builds, vms } : undefined;
}

/** The builders standing now, from the machines file, or none. */
function offloadOf(kernel: Kernel): Offload | undefined {
	if (kernel.machines === undefined) return undefined;
	let text: string;
	try {
		text = readFileSync(kernel.machines, "utf8");
	} catch {
		// No file: no builder stands.
		return undefined;
	}
	return offloadIn(text, slotsBusy(kernel));
}

/**
 * Whether a builder's slot is building now, by the lock Nix holds on its
 * file in the daemon's current-load folder while it builds there,
 * `<uri with / as _>-<slot>`, as the kernel's lock table shows it. Only
 * the file's inode need be read, so it takes no permission to its
 * contents. A slot whose file can't be read is free, as on a machine
 * that keeps no such folder.
 */
export function slotsBusy(
	kernel: Pick<Kernel, "proc" | "nixLoad">,
): (uri: string, slot: number) => boolean {
	if (kernel.nixLoad === undefined) return () => false;
	const load = kernel.nixLoad;
	const held = new Set(
		text(join(kernel.proc, "locks"))
			.split("\n")
			.map((line) => line.trim().split(/\s+/)[5]?.split(":")[2])
			.filter((inode): inode is string => inode !== undefined),
	);
	return (uri, slot) => {
		try {
			const file = join(load, `${uri.replaceAll("/", "_")}-${slot}`);
			return held.has(String(statSync(file).ino));
		} catch {
			// No lock file yet: nothing has built in that slot.
			return false;
		}
	};
}

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
	const builds = buildsIn(kernel);
	const offload = offloadOf(kernel);
	return {
		...(offload ? { offload } : {}),
		availableGib: Math.max(0, available - kept) / GIB,
		// No cgroup stalls more than the whole machine, so the walk, 6 ms
		// over optimus's 171 cgroups, is only made when it could matter.
		memoryPressure:
			memory >= MOST_MEMORY_PRESSURE
				? (memoryPressureFelt(kernel.cgroups) ?? memory)
				: memory,
		vms:
			vmsIn(kernel.proc) +
			builds.filter((build) => build.timed && !build.qemu).length,
		builds: builds.map(({ qemu: _, ...seen }) => seen),
		cpuPressure: cpu,
		// The person's own programs, as the floors keep them, so VMs past
		// the first few wait while those programs wait on memory.
		...(floors.length > 0
			? {
					floorsPressure: Math.max(
						...floors.map((floor) => stalled(join(floor, "memory.pressure"))),
					),
				}
			: {}),
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

/**
 * The most memory a cgroup has held, from its memory.peak, or nothing
 * when the cgroup is gone or keeps no peak.
 */
export function memoryPeakOf(
	cgroup: string,
	cgroups: string = KERNEL.cgroups,
): number | undefined {
	const peak = text(join(cgroups, cgroup, "memory.peak")).trim();
	return /^\d+$/.test(peak) ? Number(peak) : undefined;
}

/**
 * The command line of every process in a cgroup and those under it,
 * each with its arguments joined by spaces, so what a job runs now can
 * be read with its shell's variables already expanded.
 */
export function commandsIn(cgroup: string, kernel: Kernel = KERNEL): string[] {
	return pidsUnder(join(kernel.cgroups, cgroup))
		.map((pid) =>
			text(join(kernel.proc, pid, "cmdline"))
				.split("\0")
				.join(" ")
				.trim(),
		)
		.filter((command) => command !== "");
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
	return stalled(join(proc, "pressure", kind));
}

/** The share of time some task stalled, avg10, from a pressure file. */
function stalled(path: string): number {
	const some = /^some avg10=([\d.]+)/m.exec(text(path));
	return some ? Number(some[1]) : 0;
}

/** How deep a cgroup held at its own limit is looked for, as floors are. */
const HELD_DEPTH = FLOOR_DEPTH;

/**
 * Memory pressure as the cgroups not held at their own memory.high
 * feel it: the most any of them stalls, each read where the walk ends.
 * Nothing when no cgroup is held, so the machine's own figure stands.
 */
export function memoryPressureFelt(cgroups: string): number | undefined {
	let held = false;
	const felt = (dir: string, depth: number): number => {
		if (depth > 0 && overOwnHigh(dir)) {
			held = true;
			return 0;
		}
		const below = depth < HELD_DEPTH ? entries(dir) : [];
		if (below.length === 0) return stalled(join(dir, "memory.pressure"));
		return Math.max(...below.map((child) => felt(join(dir, child), depth + 1)));
	};
	const most = felt(cgroups, 0);
	return held ? most : undefined;
}

/** Whether a cgroup holds more than its own memory.high lets it. */
function overOwnHigh(cgroup: string): boolean {
	const high = text(join(cgroup, "memory.high")).trim();
	if (!/^\d+$/.test(high)) return false;
	return number(join(cgroup, "memory.current")) >= Number(high);
}

/** A VM's process name, cut to the kernel's 15 characters. */
const VM_PROCESS = /^qemu-(?:system-|kvm)/;

/**
 * Whether a command line, as {@link commandsIn} gives it, runs a VM: its
 * program's name is a qemu's.
 */
export function isVmCommand(command: string): boolean {
	const program = command.split(" ", 1)[0] ?? "";
	return VM_PROCESS.test(program.slice(program.lastIndexOf("/") + 1));
}

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

/**
 * Arguments with which a compositor answers and exits rather than
 * running a session: niri's `validate`, `msg`, `completions` and
 * `panic`, and sway's checks of its config and its version.
 */
const ASKS_AND_EXITS = new Set([
	"validate",
	"msg",
	"completions",
	"panic",
	"-C",
	"--validate",
	"-v",
	"--version",
	"-h",
	"--help",
	"--get-socketpath",
]);

/**
 * Whether a process in a Nix build is a check with deadlines: a name in
 * {@link TIMED}, unless it is a compositor only asked something. A
 * system build runs `niri validate` on its greeter's config, and while
 * that counted, every system build caught at it waited as a VM check
 * for as long as 14 minutes, though it ran under two.
 */
function runsTimed(proc: string, pid: string, comm: string): boolean {
	if (!isTimed(comm)) return false;
	const bare = comm.startsWith(".") ? comm.slice(1) : comm;
	if (!/^(?:niri|sway)(?:-wrapped)?$/.test(bare)) return true;
	const argv = text(join(proc, pid, "cmdline"))
		.split("\0")
		.slice(1);
	return !argv.some((argument) => ASKS_AND_EXITS.has(argument));
}

/**
 * The Nix builds the daemon runs, in order of their cgroups' names, and
 * whether a qemu runs in each, which {@link vmsIn} counts already.
 */
function buildsIn(kernel: Kernel): (BuildSeen & { qemu: boolean })[] {
	const daemon = join(kernel.cgroups, BUILDS);
	return entries(daemon)
		.filter((build) => build.startsWith("nix-build-"))
		.sort()
		.map((build) => {
			const pids = pidsUnder(join(daemon, build));
			const comms = pids.map((pid) =>
				text(join(kernel.proc, pid, "comm")).trim(),
			);
			const qemu = comms.some((comm) => VM_PROCESS.test(comm));
			const asker = askerOf(pids, kernel.proc);
			return {
				...(asker !== undefined ? { asker } : {}),
				timed:
					qemu ||
					pids.some((pid, at) => runsTimed(kernel.proc, pid, comms[at])),
				memoryPeak: number(join(daemon, build, "memory.peak")),
				qemu,
			};
		});
}

/** How far up from a build's process its worker is looked for. */
const MOST_ANCESTORS = 32;

/**
 * The cgroup of the program a build was asked for by. The daemon forks
 * a worker for each client, named `nix-daemon <client's pid>`, and a
 * build's processes descend from its worker.
 */
function askerOf(pids: readonly string[], proc: string): string | undefined {
	for (const pid of pids) {
		let at = pid;
		for (let step = 0; step < MOST_ANCESTORS && /^\d+$/.test(at); step += 1) {
			const argv = text(join(proc, at, "cmdline")).split("\0");
			if (argv[0] === "nix-daemon" && /^\d+$/.test(argv[1] ?? ""))
				return cgroupOf(Number(argv[1]), proc);
			at = /^PPid:\s*(\d+)$/m.exec(text(join(proc, at, "status")))?.[1] ?? "";
			if (at === "0" || at === "1") break;
		}
	}
	return undefined;
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
