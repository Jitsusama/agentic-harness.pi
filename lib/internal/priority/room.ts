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
 *
 * A reading is made off pi's main thread, its files read in Node's
 * thread pool: a cgroup's file can wait on the kernel's cgroup lock, a
 * process's command line on that process's memory, and pis that took no
 * keys during the night of 10 November were waiting in the kernel
 * (7QEY1S). What a job's own processes are is still read on it, by the
 * folder that keeps the queue.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { kernelText } from "./kernel-file.ts";
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
	/**
	 * The offload daemon's file naming the builder it is having lent, empty
	 * once that builder stands or the lend failed.
	 */
	readonly lending?: string;
}

export const KERNEL: Kernel = {
	proc: "/proc",
	cgroups: "/sys/fs/cgroup",
	// Written by 5FWIUS's offload daemon while a builder stands, emptied
	// when it goes.
	machines: "/run/nix-offload/machines",
	nixLoad: "/nix/var/nix/current-load",
	lending: "/run/nix-offload/lending",
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
async function offloadOf(kernel: Kernel): Promise<Offload | undefined> {
	if (kernel.machines === undefined) return undefined;
	let text: string;
	try {
		text = await readFile(kernel.machines, "utf8");
	} catch {
		// No file: no builder stands.
		return undefined;
	}
	return offloadIn(text, await slotsBusy(kernel));
}

/** {@link lendingSinceIn}, read off the main thread. */
async function lendingSince(
	kernel: Pick<Kernel, "lending">,
): Promise<number | undefined> {
	if (kernel.lending === undefined) return undefined;
	try {
		if ((await readFile(kernel.lending, "utf8")).trim() === "")
			return undefined;
		return (await stat(kernel.lending)).mtimeMs;
	} catch {
		// No file: nothing is being lent.
		return undefined;
	}
}

/**
 * Since when a builder has been being lent, by the lending file's change
 * time while it names one, or nothing.
 */
export function lendingSinceIn(
	kernel: Pick<Kernel, "lending">,
): number | undefined {
	if (kernel.lending === undefined) return undefined;
	try {
		if (readFileSync(kernel.lending, "utf8").trim() === "") return undefined;
		return statSync(kernel.lending).mtimeMs;
	} catch {
		// No file: nothing is being lent.
		return undefined;
	}
}

/**
 * Whether a builder's slot is building now, by the lock Nix holds on its
 * file in the daemon's current-load folder while it builds there,
 * `<uri with / as _>-<slot>`, as the kernel's lock table shows it. Only
 * the file's inode need be read, so it takes no permission to its
 * contents. A slot whose file can't be read is free, as on a machine
 * that keeps no such folder.
 */
async function slotsBusy(
	kernel: Pick<Kernel, "proc" | "nixLoad">,
): Promise<(uri: string, slot: number) => boolean> {
	if (kernel.nixLoad === undefined) return () => false;
	const load = kernel.nixLoad;
	const held = new Set(
		(await read(join(kernel.proc, "locks")))
			.split("\n")
			.map((line) => line.trim().split(/\s+/)[5]?.split(":")[2])
			.filter((inode): inode is string => inode !== undefined),
	);
	// Each slot's file by name, with its inode; a slot with no file yet
	// has built nothing.
	const inodes = new Map(
		await Promise.all(
			(await listed(load)).map(
				async (name) =>
					[
						name,
						await stat(join(load, name)).then(
							(seen) => String(seen.ino),
							() => "",
						),
					] as const,
			),
		),
	);
	return (uri, slot) =>
		held.has(inodes.get(`${uri.replaceAll("/", "_")}-${slot}`) ?? "");
}

/** How deep floors are looked for: user.slice/user-N/user@N/app.slice. */
const FLOOR_DEPTH = 5;

/** The innermost cgroups with a memory floor, by path. */
export async function floorsIn(cgroups: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, depth: number): Promise<boolean> => {
		const below =
			depth < FLOOR_DEPTH
				? await Promise.all(
						(await folders(dir)).map((entry) =>
							walk(join(dir, entry), depth + 1),
						),
					)
				: [];
		if (below.some(Boolean)) return true;
		if (depth > 0 && (await numberIn(join(dir, "memory.min"))) > 0) {
			found.push(dir);
			return true;
		}
		return false;
	};
	await walk(cgroups, 0);
	return found.sort();
}

/** The machine's room now, given the floors to count. */
export async function readRoom(
	floors: readonly string[],
	kernel: Kernel = KERNEL,
): Promise<Reading> {
	const pressureFile = (kind: string) =>
		read(join(kernel.proc, "pressure", kind));
	const [
		meminfo,
		memoryFile,
		cpuFile,
		ioFile,
		keptEach,
		builds,
		offload,
		vmsRunning,
		cpuinfo,
		floorsMemory,
		floorsCpu,
	] = await Promise.all([
		read(join(kernel.proc, "meminfo")),
		pressureFile("memory"),
		pressureFile("cpu"),
		pressureFile("io"),
		Promise.all(floors.map(keptBy)),
		buildsIn(kernel),
		offloadOf(kernel),
		vmsIn(kernel.proc),
		read(join(kernel.proc, "cpuinfo")),
		Promise.all(floors.map((floor) => read(join(floor, "memory.pressure")))),
		Promise.all(floors.map((floor) => read(join(floor, "cpu.pressure")))),
	]);
	const swapTotal = meminfoField(meminfo, "SwapTotal") ?? 0;
	// The swap left, on a machine with any.
	const swap =
		swapTotal > 0 ? (meminfoField(meminfo, "SwapFree") ?? 0) : undefined;
	const available = Math.min(
		meminfoField(meminfo, "MemAvailable") ?? 0,
		swap ?? Number.POSITIVE_INFINITY,
	);
	const kept = keptEach.reduce((sum, one) => sum + one, 0);
	const memory = avg10(memoryFile);
	const cpu = avg10(cpuFile);
	const io = avg10(ioFile);
	// Waiting for a lend is only while no builder stands yet.
	const lending = offload ? undefined : await lendingSince(kernel);
	// No cgroup stalls more than the whole machine, so the walk, 6 ms
	// over optimus's 171 cgroups, is only made when it could matter.
	const felt =
		memory >= MOST_MEMORY_PRESSURE
			? await memoryPressureFelt(kernel.cgroups)
			: undefined;
	return {
		...(offload ? { offload } : {}),
		...(lending !== undefined ? { lendingSince: lending } : {}),
		availableGib: Math.max(0, available - kept) / GIB,
		memoryPressure: felt ?? memory,
		vms:
			vmsRunning + builds.filter((build) => build.timed && !build.qemu).length,
		builds: builds.map(({ qemu: _, ...seen }) => seen),
		cpuPressure: cpu,
		cpuPressureMinute: avg60(cpuFile),
		ioPressure: Math.max(io, avg60(ioFile)),
		// The person's own programs, as the floors keep them, so VMs past
		// the first few wait while those programs wait on memory.
		...(floors.length > 0
			? {
					floorsPressure: Math.max(...floorsMemory.map(avg10)),
					// And on CPU, which the machine's figure hides: weights keep
					// the person's programs first while agents wait on each other.
					floorsCpuPressure: Math.max(...floorsCpu.map(avg10)),
				}
			: {}),
		cores: (cpuinfo.match(/^processor\s*:/gm) ?? []).length,
		pressure: { cpu, memory, io },
	};
}

/**
 * What a floor keeps that MemAvailable counts as free: all of it but the
 * memory its programs hold as their own.
 */
async function keptBy(floor: string): Promise<number> {
	const [floorBytes, memoryStat] = await Promise.all([
		numberIn(join(floor, "memory.min")),
		read(join(floor, "memory.stat")),
	]);
	const anon = /^anon (\d+)$/m.exec(memoryStat);
	return Math.max(0, floorBytes - (anon ? Number(anon[1]) : 0));
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
	return cgroupIn(text(join(proc, String(pid), "cgroup")));
}

/** The cgroup a process's /proc cgroup file names. */
function cgroupIn(file: string): string | undefined {
	const line = file.split("\n").find((entry) => entry.startsWith("0::"));
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
 * The most memory a cgroup has held as a job's own, from its
 * memory.peak, only while every process in it is `shell` or something
 * `shell` started: nothing for a cgroup others share, or one gone.
 *
 * A job whose shell is still where it was born sits in the cgroup every
 * job is born in, so that cgroup's peak is every job's: by 10 November
 * 1,028 of the 2,494 outcomes with a peak held one of the work
 * service's, 397 of them exactly the 10,804,027,392 bytes its
 * memory.peak read that morning (80ECO2's 10.06 GiB).
 */
export function ownedMemoryPeakOf(
	cgroup: string,
	shell: number,
	kernel: Pick<Kernel, "proc" | "cgroups"> = KERNEL,
): number | undefined {
	const members = text(join(kernel.cgroups, cgroup, "cgroup.procs"))
		.split("\n")
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
	if (
		members.length === 0 ||
		!members.every((pid) => startedBy(pid, shell, kernel.proc))
	) {
		return undefined;
	}
	return memoryPeakOf(cgroup, kernel.cgroups);
}

/** Whether `pid` is `shell` or a process `shell` started, as /proc says. */
function startedBy(pid: number, shell: number, proc: string): boolean {
	let at = pid;
	for (let step = 0; step < MOST_ANCESTORS; step += 1) {
		if (at === shell) return true;
		const parent = parentOf(at, proc);
		if (parent === undefined || parent <= 1) return false;
		at = parent;
	}
	return false;
}

/** A process's parent, from /proc's status; nothing for a process gone. */
function parentOf(pid: number, proc: string): number | undefined {
	return parentIn(text(join(proc, String(pid), "status")));
}

/** The parent a process's /proc status file names. */
function parentIn(status: string): number | undefined {
	const parent = /^PPid:\s*(\d+)$/m.exec(status)?.[1];
	return parent === undefined ? undefined : Number(parent);
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

/** One field of /proc/meminfo's text, in bytes. */
function meminfoField(meminfo: string, field: string): number | undefined {
	const line = meminfo
		.split("\n")
		.find((entry) => entry.startsWith(`${field}:`));
	const kib = Number(line?.split(/\s+/)[1]);
	return Number.isFinite(kib) ? kib * 1024 : undefined;
}

/** The share of time some task stalled, avg10, from a pressure file's text. */
function avg10(pressure: string): number {
	const some = /^some avg10=([\d.]+)/m.exec(pressure);
	return some ? Number(some[1]) : 0;
}

/** The share of time some task stalled over the last minute, from a pressure file's text. */
function avg60(pressure: string): number {
	const some = /^some avg10=[\d.]+ avg60=([\d.]+)/m.exec(pressure);
	return some ? Number(some[1]) : 0;
}

/** How deep a cgroup held at its own limit is looked for, as floors are. */
const HELD_DEPTH = FLOOR_DEPTH;

/**
 * Memory pressure as the cgroups not held at their own memory.high
 * feel it: the most any of them stalls, each read where the walk ends.
 * Nothing when no cgroup is held, so the machine's own figure stands.
 */
async function memoryPressureFelt(
	cgroups: string,
): Promise<number | undefined> {
	let held = false;
	const felt = async (dir: string, depth: number): Promise<number> => {
		if (depth > 0 && (await overOwnHigh(dir))) {
			held = true;
			return 0;
		}
		const below = depth < HELD_DEPTH ? await folders(dir) : [];
		if (below.length === 0)
			return avg10(await read(join(dir, "memory.pressure")));
		const each = await Promise.all(
			below.map((child) => felt(join(dir, child), depth + 1)),
		);
		return Math.max(...each);
	};
	const most = await felt(cgroups, 0);
	return held ? most : undefined;
}

/** Whether a cgroup holds more than its own memory.high lets it. */
async function overOwnHigh(cgroup: string): Promise<boolean> {
	const high = (await read(join(cgroup, "memory.high"))).trim();
	if (!/^\d+$/.test(high)) return false;
	return (await numberIn(join(cgroup, "memory.current"))) >= Number(high);
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
async function vmsIn(proc: string): Promise<number> {
	const pids = (await listed(proc)).filter((entry) => /^\d+$/.test(entry));
	const comms = await Promise.all(
		pids.map((pid) => read(join(proc, pid, "comm"))),
	);
	return comms.filter((comm) => VM_PROCESS.test(comm)).length;
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
async function runsTimed(
	proc: string,
	pid: string,
	comm: string,
): Promise<boolean> {
	if (!isTimed(comm)) return false;
	const bare = comm.startsWith(".") ? comm.slice(1) : comm;
	if (!/^(?:niri|sway)(?:-wrapped)?$/.test(bare)) return true;
	const argv = (await read(join(proc, pid, "cmdline"))).split("\0").slice(1);
	return !argv.some((argument) => ASKS_AND_EXITS.has(argument));
}

/**
 * The Nix builds the daemon runs, in order of their cgroups' names, and
 * whether a qemu runs in each, which {@link vmsIn} counts already.
 */
async function buildsIn(
	kernel: Kernel,
): Promise<(BuildSeen & { qemu: boolean })[]> {
	const daemon = join(kernel.cgroups, BUILDS);
	const builds = (await folders(daemon))
		.filter((build) => build.startsWith("nix-build-"))
		.sort();
	return Promise.all(
		builds.map(async (build) => {
			const pids = await pidsBelow(join(daemon, build));
			const comms = await Promise.all(
				pids.map(async (pid) =>
					(await read(join(kernel.proc, pid, "comm"))).trim(),
				),
			);
			const qemu = comms.some((comm) => VM_PROCESS.test(comm));
			const [asker, timedEach, memoryPeak] = await Promise.all([
				askerOf(pids, kernel.proc),
				qemu
					? []
					: Promise.all(
							pids.map((pid, at) =>
								runsTimed(kernel.proc, pid, comms[at] ?? ""),
							),
						),
				numberIn(join(daemon, build, "memory.peak")),
			]);
			return {
				...(asker !== undefined ? { asker } : {}),
				timed: qemu || timedEach.some(Boolean),
				memoryPeak,
				qemu,
			};
		}),
	);
}

/**
 * How far up a process's parents are followed: to a build's worker, or
 * to a job's shell.
 */
const MOST_ANCESTORS = 32;

/**
 * The cgroup of the program a build was asked for by. The daemon forks
 * a worker for each client, named `nix-daemon <client's pid>`, and a
 * build's processes descend from its worker.
 */
async function askerOf(
	pids: readonly string[],
	proc: string,
): Promise<string | undefined> {
	for (const pid of pids) {
		let at: number | undefined = Number(pid);
		for (let step = 0; step < MOST_ANCESTORS && at !== undefined; step += 1) {
			const argv = (await read(join(proc, String(at), "cmdline"))).split("\0");
			if (argv[0] === "nix-daemon" && /^\d+$/.test(argv[1] ?? ""))
				return cgroupIn(await read(join(proc, argv[1] ?? "", "cgroup")));
			at = parentIn(await read(join(proc, String(at), "status")));
			if (at === 0 || at === 1) break;
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

/** {@link pidsUnder}, read off the main thread. */
async function pidsBelow(cgroup: string): Promise<string[]> {
	const [procs, children] = await Promise.all([
		read(join(cgroup, "cgroup.procs")),
		folders(cgroup),
	]);
	const below = await Promise.all(
		children.map((child) => pidsBelow(join(cgroup, child))),
	);
	return [
		...procs.split("\n").filter((pid) => /^\d+$/.test(pid)),
		...below.flat(),
	];
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

/**
 * A kernel file's text, read off the main thread (kernel-file.ts says
 * why not whole); empty once it can't be read.
 */
async function read(path: string): Promise<string> {
	try {
		return await kernelText(path);
	} catch {
		return "";
	}
}

/** A file's number, read off the main thread; nought once it isn't one. */
async function numberIn(path: string): Promise<number> {
	const value = Number((await read(path)).trim());
	return Number.isFinite(value) ? value : 0;
}

/** A folder's entries, read off the main thread; none once it can't be. */
async function listed(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/** A folder's folders, read off the main thread; none once it can't be. */
async function folders(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}
