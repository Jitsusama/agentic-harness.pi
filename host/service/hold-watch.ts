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
 * it waits in), or idle (S); how many pages it faulted in from disk; how
 * much CPU it used; and the process's swap. It writes a line when the
 * hold passes `after`, another each `still` ms it lasts, so a kill still
 * leaves a trace, and a last one when the loop turns again. It writes to
 * the journal's descriptor directly, since the loop that would carry a
 * write is the one held. Off Linux, the lines say only how long.
 */

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
}

/**
 * The thread's whole program. It is source rather than a file beside
 * this one, as web/article.ts's is, so it runs the same whether this
 * module was loaded as TypeScript or as JavaScript. Every read is its
 * own thread's to wait on, never the loop's.
 */
const PROGRAM = `
const { workerData } = require("node:worker_threads");
const { readFileSync, writeSync } = require("node:fs");
const { ticks, fd, every, after, still, pid, clock } = workerData;
const count = new Int32Array(ticks);
const task = "/proc/self/task/" + pid;
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
	const kb = /^VmSwap:\\s+(\\d+)/m.exec(read("/proc/self/status") ?? "")?.[1];
	return kb === undefined ? undefined : Math.round(Number(kb) / 1024);
};
const seen = (hold) => {
	const now = thread();
	if (now === undefined) return;
	const wchan = (read(task + "/wchan") ?? "").trim();
	const key = now.state === "R" || wchan === "" || wchan === "0" ? now.state : now.state + " in " + wchan;
	hold.seen.set(key, (hold.seen.get(key) ?? 0) + 1);
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
	const head = over ? "the loop held " + seconds(held) + " s" : "the loop has held " + seconds(held) + " s so far";
	return parts.length > 0 ? head + ": " + parts.join("; ") : head;
};
let last = Atomics.load(count, 0);
let moved = performance.now();
let hold;
setInterval(() => {
	const now = performance.now();
	const tick = Atomics.load(count, 0);
	if (tick !== last) {
		if (hold) say(described(hold, now - moved - every, true));
		last = tick;
		moved = now;
		hold = undefined;
		return;
	}
	if (now - moved < after) return;
	if (!hold) {
		hold = { from: thread(), swap: swapMb(), seen: new Map(), told: now };
		seen(hold);
		say(described(hold, now - moved, false));
		return;
	}
	seen(hold);
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
