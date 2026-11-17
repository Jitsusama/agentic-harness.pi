/**
 * A host's loop, watched from a thread of its own, so a hold says what
 * held it. On 15 November the background host's loop held 18 s and then
 * 61 s, and the journal could say only how long: nothing on the loop runs
 * while it is held, so nothing on it can look. A thread beside it can.
 *
 * The loop ticks a shared counter every `every` ms; the thread reads it
 * every `every` ms and does nothing more while it moves. Once it has
 * stood still for `after` ms, the thread reads the main thread's own
 * state from /proc as the hold goes on: whether it is running (R), asleep
 * in the kernel waiting on a page or a lock (D, with the kernel function
 * it waits in), or idle (S); which call it waits in, and the path, socket
 * or file that call was given, since on 15 November a hold seen only as D
 * in filename_create could have been any of five calls on any folder; how
 * many pages it faulted in from disk; how
 * much CPU it used; and the process's swap. It writes a line when the
 * hold passes `after`, another each `still` ms it lasts, so a kill still
 * leaves a trace, and a last one when the loop turns again. It writes to
 * the journal's descriptor directly, since the loop that would carry a
 * write is the one held. Off Linux, the lines say only how long.
 *
 * Given a beat, the thread also tells systemd's watchdog the host lives
 * while its loop sleeps in the disk: at 00:05 on 17 November the
 * background host's loop slept 7 to 155 s in btrfs calls, its thread on
 * a CPU 0.3 s, and the watchdog killed it at 120 s, taking five heavy
 * runs with it; its replacement faced the same disk, so the kill bought
 * nothing. It beats only while the newest look finds the main thread in
 * D inside a filesystem call, and the thread has spent under a quarter
 * of the hold on a CPU, so a JavaScript spin or a wait off the disk (a
 * lock, a socket) still goes unbeaten for the watchdog to end. Its
 * looks once a hold passes `after` sometimes catch the thread between
 * two calls, running, as the 22:17 hold of 16 November's three in 25
 * did, so a strict every-look rule would stop beating a stall that goes
 * on. It beats at most once a beat's `every`, journals each beat, and
 * stops at its `cap`, past which no disk stall is worth the wait.
 */

import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import { clockTicksPerSecond } from "../../lib/internal/process-ticks.ts";

/** How often the loop ticks and the thread looks, in ms. */
const EVERY_MS = 1000;

/** How long the loop may stand still before the thread looks closer. */
const AFTER_MS = 5000;

/** How often a hold still under way is said again, in ms. */
const STILL_MS = 30_000;

/** Standard error, which systemd's journal keeps. */
const STDERR = 2;

/** Where the main thread's state is read from: its own process's. */
const PROC = "/proc/self";

/**
 * The longest a loop asleep in the disk is beaten for, in ms: five times
 * the watchdog's two minutes, and nearly four times the longest wait in
 * a filesystem call of 17 November's stall (155 s).
 */
const BEAT_CAP_MS = 10 * 60_000;

/** How a beat is told to systemd: as the loop's own are. */
const BEAT_COMMAND: readonly string[] = ["systemd-notify", "WATCHDOG=1"];

/** What a call's argument is, so the line can say it: where it is in the call. */
type Given = readonly [
	name: string,
	kind: "path" | "socket" | "fd" | "none",
	index: number,
];

/**
 * The calls a held loop is likeliest to wait in, by their number on
 * x86_64: those that take a path (a create waits on its folder's lock),
 * a socket's address, or a descriptor, and the waits that take neither.
 */
const X64_CALLS: Readonly<Record<number, Given>> = {
	0: ["read", "fd", 0],
	1: ["write", "fd", 0],
	2: ["open", "path", 0],
	3: ["close", "fd", 0],
	4: ["stat", "path", 0],
	5: ["fstat", "fd", 0],
	6: ["lstat", "path", 0],
	7: ["poll", "none", 0],
	17: ["pread64", "fd", 0],
	18: ["pwrite64", "fd", 0],
	20: ["writev", "fd", 0],
	21: ["access", "path", 0],
	35: ["nanosleep", "none", 0],
	42: ["connect", "socket", 1],
	49: ["bind", "socket", 1],
	59: ["execve", "path", 0],
	61: ["wait4", "none", 0],
	74: ["fsync", "fd", 0],
	75: ["fdatasync", "fd", 0],
	77: ["ftruncate", "fd", 0],
	82: ["rename", "path", 1],
	83: ["mkdir", "path", 0],
	84: ["rmdir", "path", 0],
	86: ["link", "path", 1],
	87: ["unlink", "path", 0],
	88: ["symlink", "path", 1],
	89: ["readlink", "path", 0],
	133: ["mknod", "path", 0],
	202: ["futex", "none", 0],
	217: ["getdents64", "fd", 0],
	230: ["clock_nanosleep", "none", 0],
	232: ["epoll_wait", "none", 0],
	257: ["openat", "path", 1],
	258: ["mkdirat", "path", 1],
	259: ["mknodat", "path", 1],
	262: ["newfstatat", "path", 1],
	263: ["unlinkat", "path", 1],
	264: ["renameat", "path", 3],
	265: ["linkat", "path", 3],
	266: ["symlinkat", "path", 2],
	267: ["readlinkat", "path", 1],
	269: ["faccessat", "path", 1],
	280: ["utimensat", "path", 1],
	281: ["epoll_pwait", "none", 0],
	285: ["fallocate", "fd", 0],
	316: ["renameat2", "path", 3],
	332: ["statx", "path", 1],
	439: ["faccessat2", "path", 1],
};

/** The same calls by their number on aarch64, which has only the *at forms. */
const ARM64_CALLS: Readonly<Record<number, Given>> = {
	22: ["epoll_pwait", "none", 0],
	33: ["mknodat", "path", 1],
	34: ["mkdirat", "path", 1],
	35: ["unlinkat", "path", 1],
	36: ["symlinkat", "path", 2],
	37: ["linkat", "path", 3],
	38: ["renameat", "path", 3],
	46: ["ftruncate", "fd", 0],
	47: ["fallocate", "fd", 0],
	48: ["faccessat", "path", 1],
	56: ["openat", "path", 1],
	57: ["close", "fd", 0],
	61: ["getdents64", "fd", 0],
	63: ["read", "fd", 0],
	64: ["write", "fd", 0],
	66: ["writev", "fd", 0],
	67: ["pread64", "fd", 0],
	68: ["pwrite64", "fd", 0],
	78: ["readlinkat", "path", 1],
	79: ["newfstatat", "path", 1],
	80: ["fstat", "fd", 0],
	82: ["fsync", "fd", 0],
	83: ["fdatasync", "fd", 0],
	88: ["utimensat", "path", 1],
	98: ["futex", "none", 0],
	101: ["nanosleep", "none", 0],
	115: ["clock_nanosleep", "none", 0],
	200: ["bind", "socket", 1],
	203: ["connect", "socket", 1],
	221: ["execve", "path", 0],
	260: ["wait4", "none", 0],
	276: ["renameat2", "path", 3],
	291: ["statx", "path", 1],
	439: ["faccessat2", "path", 1],
};

/** The calls this machine numbers as the tables do; none elsewhere. */
function callsOf(arch: string): Readonly<Record<number, Given>> {
	if (arch === "x64") return X64_CALLS;
	if (arch === "arm64") return ARM64_CALLS;
	return {};
}

/** What a watch is given; each has a default for a live host. */
export interface HoldWatchOptions {
	/** The descriptor lines are written to; standard error by default. */
	readonly fd?: number;
	/** How often the loop ticks and the thread looks, in ms. */
	readonly every?: number;
	/** How long the loop stands still before it counts as held, in ms. */
	readonly after?: number;
	/** How often a hold still under way is said again, in ms. */
	readonly still?: number;
	/** Where the main thread's state is read; this process's /proc by default. */
	readonly proc?: string;
	/** Beat the watchdog for a loop asleep in the disk, as this says; none by default. */
	readonly beat?: BeatOptions;
}

/** How the thread beats systemd's watchdog for a loop asleep in the disk. */
export interface BeatOptions {
	/** How often it may beat, in ms: the loop's own beat. */
	readonly every: number;
	/** How long into a hold it stops beating, in ms; BEAT_CAP_MS by default. */
	readonly cap?: number;
	/** The command a beat runs; systemd-notify WATCHDOG=1 by default. */
	readonly command?: readonly string[];
	/** The environment it runs in, naming systemd's notify socket. */
	readonly env: NodeJS.ProcessEnv;
}

/** What the thread is handed. */
interface Watched {
	readonly ticks: SharedArrayBuffer;
	readonly fd: number;
	readonly every: number;
	readonly after: number;
	readonly still: number;
	readonly pid: number;
	readonly clock: number;
	readonly home: string;
	readonly calls: Readonly<Record<number, Given>>;
	readonly proc: string;
	readonly beat:
		| {
				readonly every: number;
				readonly cap: number;
				readonly command: readonly string[];
				readonly env: NodeJS.ProcessEnv;
		  }
		| undefined;
}

/**
 * The thread's whole program. It is source rather than a file beside
 * this one, as web/article.ts's is, so it runs the same whether this
 * module was loaded as TypeScript or as JavaScript. Every read is its
 * own thread's to wait on, never the loop's.
 */
const PROGRAM = `
const { workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { openSync, readFileSync, readSync, readlinkSync, writeSync } = require("node:fs");
const { ticks, fd, every, after, still, pid, clock, home, calls, proc, beat } = workerData;
const count = new Int32Array(ticks);
const task = proc + "/task/" + pid;
// The most of a path a line gives, a page of memory, and a unix socket's
// address: its family and up to 108 bytes of path.
const LONGEST = 160;
const PAGE = 4096;
const AF_UNIX = 1;
const UNIX_ADDRESS = 110;
const read = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};
const thread = () => {
	const stat = read(task + "/stat");
	if (stat === undefined) return undefined;
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return {
		state: fields[0],
		faults: Number(fields[9]),
		cpu: (Number(fields[11]) + Number(fields[12])) / clock,
	};
};
const swapMb = () => {
	const kb = /^VmSwap:\\s+(\\d+)/m.exec(read(proc + "/status") ?? "")?.[1];
	return kb === undefined ? undefined : Math.round(Number(kb) / 1024);
};
// A path read from the process's memory may hold anything a file's name
// can, so a control character is written as its code: a name with a
// newline must not start a journal line of its own.
const plain = (text) => text.replace(/[\\x00-\\x1f\\x7f]/g, (one) => "\\\\x" + one.charCodeAt(0).toString(16).padStart(2, "0"));
const shortened = (raw) => {
	const path = plain(raw);
	const shown = home && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
	return shown.length > LONGEST ? shown.slice(0, LONGEST) + "..." : shown;
};
let memory;
// Up to most bytes of this process's memory at an address, read a page
// at a time so a string ending before an unmapped page still reads.
const bytesAt = (address, most) => {
	if (memory === undefined) memory = openSync(proc + "/mem", "r");
	const chunks = [];
	let at = address;
	let left = most;
	while (left > 0) {
		const size = Math.min(left, PAGE - (at % PAGE));
		const chunk = Buffer.alloc(size);
		const got = readSync(memory, chunk, 0, size, at);
		chunks.push(chunk.subarray(0, got));
		if (got < size || chunk.subarray(0, got).includes(0)) break;
		at += size;
		left -= size;
	}
	return Buffer.concat(chunks);
};
const stringAt = (address) => {
	const bytes = bytesAt(address, PAGE);
	const end = bytes.indexOf(0);
	return shortened(bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8"));
};
// A unix socket's path (@ for an abstract one), or another's family.
const socketAt = (address) => {
	const bytes = bytesAt(address, UNIX_ADDRESS);
	if (bytes.length < 2) return "a socket";
	const family = bytes.readUInt16LE(0);
	if (family !== AF_UNIX) return "a socket of family " + family;
	const path = bytes.subarray(2);
	if (path[0] === 0) return "@" + plain(path.subarray(1).toString("utf8").split("\\0")[0]);
	const end = path.indexOf(0);
	return shortened(path.subarray(0, end < 0 ? path.length : end).toString("utf8"));
};
// The call the main thread waits in, named with what it was given: a
// path, a socket's address or the file behind a descriptor; and whether
// it is a filesystem call, given a path or a file's descriptor.
const callOf = () => {
	const fields = (read(task + "/syscall") ?? "").trim().split(" ");
	const number = Number(fields[0]);
	if (fields[0] === "" || !Number.isInteger(number) || number < 0) return undefined;
	const known = calls[number];
	if (known === undefined) return { said: "call " + number, disk: false };
	const [name, kind, index] = known;
	try {
		const arg = Number(BigInt(fields[1 + index] ?? "0"));
		if (kind === "path") return { said: name + " " + stringAt(arg), disk: true };
		if (kind === "socket") return { said: name + " " + socketAt(arg), disk: false };
		if (kind === "fd") {
			const file = readlinkSync(proc + "/fd/" + arg);
			return { said: name + " " + shortened(file), disk: file.startsWith("/") };
		}
	} catch {
		// Memory or a descriptor gone by the time it was read: the name alone.
	}
	return { said: name, disk: kind === "path" };
};
const seen = (hold) => {
	const now = thread();
	hold.last = undefined;
	if (now === undefined) return;
	const wchan = (read(task + "/wchan") ?? "").trim();
	const key = now.state === "R" || wchan === "" || wchan === "0" ? now.state : now.state + " in " + wchan;
	hold.seen.set(key, (hold.seen.get(key) ?? 0) + 1);
	if (now.state === "R") return;
	const call = callOf();
	if (call === undefined) return;
	hold.calls.set(call.said, (hold.calls.get(call.said) ?? 0) + 1);
	if (now.state === "D" && call.disk) hold.last = { said: call.said, cpu: now.cpu };
};
const seconds = (ms) => (ms / 1000).toFixed(1);
const say = (line) => {
	try {
		writeSync(fd, "pi-host: " + line + "\\n");
	} catch {
		// A journal gone away is nothing a watch can mend.
	}
};
const described = (hold, held, over) => {
	const parts = [];
	const now = thread();
	if (hold.from && now) {
		parts.push("its thread ran " + (now.cpu - hold.from.cpu).toFixed(1) + " s on a CPU");
		parts.push("faulted " + (now.faults - hold.from.faults) + " pages in from disk");
	}
	const swap = swapMb();
	if (hold.swap !== undefined && swap !== undefined) parts.push("swap went from " + hold.swap + " to " + swap + " MB");
	const states = [...hold.seen].sort((a, b) => b[1] - a[1]).map(([key, times]) => key + " " + times);
	if (states.length > 0) parts.push("seen " + states.join(", "));
	const waits = [...hold.calls].sort((a, b) => b[1] - a[1]).map(([call, times]) => call + " " + times);
	if (waits.length > 0) parts.push("waiting in " + waits.join(", "));
	const head = over ? "the loop held " + seconds(held) + " s" : "the loop has held " + seconds(held) + " s so far";
	return parts.length > 0 ? head + ": " + parts.join("; ") : head;
};
// Beat systemd's watchdog for a loop asleep in the disk, as the header
// of hold-watch.ts says: at most once a beat, journalled, until the cap.
// Its CPU is counted from the last look that saw the loop move, so a
// hold's first look already knows how much of it ran; with no reading
// to count from, it can't be judged, and isn't beaten.
const QUARTER = 4;
const beatFor = (hold, now, held) => {
	if (!beat || hold.last === undefined || hold.capped || hold.beating) return;
	const base = hold.moving ?? hold.from;
	if (base === undefined) return;
	const ran = (hold.last.cpu - base.cpu) * 1000;
	if (ran * QUARTER > held) return;
	if (held > beat.cap) {
		hold.capped = true;
		say("stopped beating the watchdog for the loop at its cap of " + seconds(beat.cap) + " s, held " + seconds(held) + " s in " + hold.last.said);
		return;
	}
	if (now - hold.beat < beat.every) return;
	hold.beat = now;
	hold.beating = true;
	const what = "the watchdog for the loop, held " + seconds(held) + " s in " + hold.last.said;
	let settled = false;
	// Said once the beat is known sent or not; one that fails leaves the
	// watchdog to judge, as before.
	const done = (failed) => {
		if (settled) return;
		settled = true;
		hold.beating = false;
		say(failed === undefined ? "beat " + what : "couldn't beat " + what + ": " + failed);
	};
	try {
		// Spawned, never waited on, so a child stuck on the same disk can't
		// silence this thread's lines, and none is sent while one is out. A
		// child of this thread stays in the host's own cgroup, as systemd
		// needs to credit the beat: the placement that moves children into
		// jobs patches only the main thread's spawn.
		const child = spawn(beat.command[0], beat.command.slice(1), { env: beat.env, stdio: "ignore", timeout: beat.every });
		child.once("error", (error) => done(error.message));
		child.once("exit", (code, signal) => done(code === 0 ? undefined : signal ? "it ended on " + signal : "it ended with " + code));
	} catch (error) {
		done(error instanceof Error ? error.message : String(error));
	}
};
let last = Atomics.load(count, 0);
let moved = performance.now();
let moving;
let hold;
setInterval(() => {
	const now = performance.now();
	const tick = Atomics.load(count, 0);
	if (tick !== last) {
		if (hold) say(described(hold, now - moved - every, true));
		last = tick;
		moved = now;
		hold = undefined;
		// The thread's CPU as the loop last moved, read only for a beat.
		if (beat) moving = thread();
		return;
	}
	if (now - moved < after) return;
	if (!hold) {
		hold = { from: thread(), moving, swap: swapMb(), seen: new Map(), calls: new Map(), told: now, beat: -Infinity, beating: false, capped: false, last: undefined };
		seen(hold);
		say(described(hold, now - moved, false));
		beatFor(hold, now, now - moved);
		return;
	}
	seen(hold);
	beatFor(hold, now, now - moved);
	if (now - hold.told >= still) {
		hold.told = now;
		say(described(hold, now - moved, false));
	}
}, every);
`;

/**
 * Watch this process's loop from a thread of its own, saying in the
 * journal what held it whenever it stands still past `after`. Answers
 * how to stop watching. Neither the tick nor the thread keeps the
 * process alive.
 */
export function watchHolds(options: HoldWatchOptions = {}): () => void {
	const every = options.every ?? EVERY_MS;
	const ticks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	const count = new Int32Array(ticks);
	const watched: Watched = {
		ticks,
		fd: options.fd ?? STDERR,
		every,
		after: options.after ?? AFTER_MS,
		still: options.still ?? STILL_MS,
		pid: process.pid,
		clock: clockTicksPerSecond(),
		home: homedir(),
		calls: callsOf(process.arch),
		proc: options.proc ?? PROC,
		beat: options.beat && {
			every: options.beat.every,
			cap: options.beat.cap ?? BEAT_CAP_MS,
			command: options.beat.command ?? BEAT_COMMAND,
			env: options.beat.env,
		},
	};
	const thread = new Worker(PROGRAM, { eval: true, workerData: watched });
	thread.unref();
	// A thread that fails to start leaves the host as it was: unwatched.
	thread.on("error", () => {});
	const tick = setInterval(() => Atomics.add(count, 0, 1), every);
	tick.unref();
	return () => {
		clearInterval(tick);
		void thread.terminate();
	};
}
