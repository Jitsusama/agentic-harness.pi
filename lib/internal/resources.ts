/**
 * What this pi process and the work it ran have used: CPU, disk I/O and
 * memory, read from the kernel's own counters.
 *
 * On Linux, `/proc/self/stat` keeps the CPU time of every child pi has
 * waited for, and a shell waits for its own children, so a build run
 * through bash lands in pi's figure the moment the shell exits.
 * `/proc/self/io` adds reaped children's disk traffic the same way (50
 * MB written by a child `dd` showed in pi's own counters). That holds
 * wherever a child runs, including the shared cgroup for work that
 * `JOBS_CGROUP` moves every child into, which a per-window cgroup
 * reading would lose. Reading both files and the resident size takes
 * about 11 µs.
 *
 * What it cannot see: work a daemon does on pi's behalf (a `nix build`
 * runs in nix-daemon), a child that is still running (it counts when it
 * ends), and the memory a child used. Elsewhere than Linux, Node's own
 * resource usage covers pi alone, and the child figures are null rather
 * than zero, since nothing was measured.
 */

import { readFileSync } from "node:fs";

/** Running totals for this process since it started. */
export interface Counters {
	/** CPU time pi itself spent, user and system. */
	readonly cpuSelfMs: number;
	/** CPU time of the children pi waited for, and theirs; null unmeasured. */
	readonly cpuChildrenMs: number | null;
	/** Bytes read from storage by pi and its reaped children. */
	readonly readBytes: number | null;
	/** Bytes written to storage by pi and its reaped children. */
	readonly writeBytes: number | null;
	/** What pi holds in memory now. */
	readonly rssBytes: number;
}

/**
 * Linux reports CPU time in clock ticks of `USER_HZ`, which the kernel
 * fixes at 100 for every architecture's user-space interface.
 */
const MS_PER_TICK = 10;

/** pi's own and its reaped children's CPU time, from `/proc/self/stat`. */
export function parseStat(
	text: string,
): { selfMs: number; childrenMs: number } | undefined {
	// The command name is in parentheses and may hold spaces, so fields
	// are counted from the last closing one: state is field 3, utime 14.
	const close = text.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = text
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	const [utime, stime, cutime, cstime] = [11, 12, 13, 14].map((i) =>
		Number(fields[i]),
	);
	if (![utime, stime, cutime, cstime].every(Number.isFinite)) return undefined;
	return {
		selfMs: ((utime ?? 0) + (stime ?? 0)) * MS_PER_TICK,
		childrenMs: ((cutime ?? 0) + (cstime ?? 0)) * MS_PER_TICK,
	};
}

/** Storage bytes read and written, from `/proc/self/io`. */
export function parseIo(
	text: string,
): { readBytes: number; writeBytes: number } | undefined {
	const field = (name: string): number | undefined => {
		const match = new RegExp(`^${name}:\\s*(\\d+)$`, "m").exec(text);
		return match ? Number(match[1]) : undefined;
	};
	const readBytes = field("read_bytes");
	const writeBytes = field("write_bytes");
	if (readBytes === undefined || writeBytes === undefined) return undefined;
	return { readBytes, writeBytes };
}

/** What {@link readCounters} reads with, so a test can stand in. */
export interface CounterDeps {
	readonly platform?: NodeJS.Platform;
	readonly read?: (path: string) => string;
	readonly usage?: () => NodeJS.ResourceUsage;
	readonly rss?: () => number;
}

/** Read nothing that fails: a file a sandbox hides gives no figure. */
function tryRead(read: (path: string) => string, path: string): string {
	try {
		return read(path);
	} catch {
		return "";
	}
}

/** This process's counters now. */
export function readCounters(deps: CounterDeps = {}): Counters {
	const platform = deps.platform ?? process.platform;
	const read = deps.read ?? ((path) => readFileSync(path, "utf8"));
	const usage = deps.usage ?? (() => process.resourceUsage());
	const rssBytes = (deps.rss ?? (() => process.memoryUsage.rss()))();
	const cpu =
		platform === "linux"
			? parseStat(tryRead(read, "/proc/self/stat"))
			: undefined;
	const io =
		platform === "linux" ? parseIo(tryRead(read, "/proc/self/io")) : undefined;
	if (cpu) {
		return {
			cpuSelfMs: cpu.selfMs,
			cpuChildrenMs: cpu.childrenMs,
			readBytes: io?.readBytes ?? null,
			writeBytes: io?.writeBytes ?? null,
			rssBytes,
		};
	}
	const own = usage();
	return {
		cpuSelfMs: Math.round((own.userCPUTime + own.systemCPUTime) / 1000),
		cpuChildrenMs: null,
		readBytes: null,
		writeBytes: null,
		rssBytes,
	};
}

/** What was used between two readings, with the memory held at the later. */
export type Usage = Counters;

/** The difference between two readings of one process. */
export function usageBetween(before: Counters, after: Counters): Usage {
	const less = (a: number | null, b: number | null): number | null =>
		a === null || b === null ? null : Math.max(0, a - b);
	return {
		cpuSelfMs: Math.max(0, after.cpuSelfMs - before.cpuSelfMs),
		cpuChildrenMs: less(after.cpuChildrenMs, before.cpuChildrenMs),
		readBytes: less(after.readBytes, before.readBytes),
		writeBytes: less(after.writeBytes, before.writeBytes),
		rssBytes: after.rssBytes,
	};
}

/** Nothing used yet: what the first reading in a process is measured from. */
export const NOTHING: Counters = {
	cpuSelfMs: 0,
	cpuChildrenMs: 0,
	readBytes: 0,
	writeBytes: 0,
	rssBytes: 0,
};
