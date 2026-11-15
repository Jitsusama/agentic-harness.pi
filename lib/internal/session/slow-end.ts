/**
 * What holds a pi that is slow to end.
 *
 * A pi asked to end, by a signal or by its session quitting, runs every
 * extension's shutdown in turn before it exits. One that waits on
 * something that never answers keeps the process up until whatever
 * asked kills it, and nothing said what it waited on. This watches from
 * the moment it was asked: once a pi is still ending its while after,
 * it says what the process still holds open and what runs under it.
 * The watch's timer never keeps the process up, so a pi that can end
 * ends as soon as it would have. Writing what it saw is synchronous and
 * blocks the loop a few ms, once, only in a pi already slow to end.
 *
 * One hold the watch's timer can't see: node's exit waits for libuv's
 * threadpool, and a name lookup running there can't be cancelled. With
 * the network gone and no nameserver answering, that holds a pi past
 * its exit listeners until the resolver gives up, and no timer fires
 * once exit has begun. So a pi exiting with a lookup pending says so
 * and ends itself by its own TERM, the only way node leaves without
 * waiting on the threadpool: even `process.reallyExit` waits.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** A process under this one. */
export interface Child {
	pid: number;
	command: string;
}

/** A pi still ending its while after it was asked to. */
export interface SlowEnd {
	pid: number;
	session: string;
	cause: string;
	afterMs: number;
	/** What held its exit, where that is known. */
	held?: string;
	active: readonly string[];
	children: readonly Child[];
}

/** What a name lookup still running in libuv's threadpool shows as. */
export const PENDING_LOOKUP = "GetAddrInfoReqWrap";

/** A timer the watch starts, which must never keep the process up. */
export interface WatchTimer {
	unref(): void;
	clear(): void;
}

/** Where signals are heard: the process, or a stand-in under test. */
export interface SignalSource {
	on(signal: string, listener: () => void): unknown;
	off(signal: string, listener: () => void): unknown;
	listenerCount(signal: string): number;
}

/** The signals that ask a pi to end, which the watch times from. */
const ENDING_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/** How many records a machine keeps, newest first. */
const KEPT_RECORDS = 100;

/** A timer on the process's own clock. */
function processTimer(run: () => void, ms: number): WatchTimer {
	const timer = setTimeout(run, ms);
	return {
		unref: () => timer.unref(),
		clear: () => clearTimeout(timer),
	};
}

/**
 * Watches for a pi still ending `afterMs` after it was asked to: from
 * an ending signal, or from `arm` when its session quits, whichever
 * comes first. It calls `onSlow` once, with that first cause.
 *
 * Once armed it listens no more, since a listener changes what a
 * signal does: pi drops its own handlers as a quit begins, and one left
 * of the watch's would keep a later TERM from ending the process. For
 * the same reason, a signal nothing but the watch heard is sent again
 * through `raise`, so it ends the process as it would have. `onArm` is
 * told once, with the cause, as the watch arms.
 */
export function watchSlowEnd(options: {
	afterMs: number;
	signals: SignalSource;
	onSlow: (cause: string, afterMs: number) => void;
	onArm?: (cause: string) => void;
	raise?: (signal: string) => void;
	setTimer?: (run: () => void, ms: number) => WatchTimer;
}): { arm(cause: string): void; stop(): void } {
	const { signals } = options;
	const setTimer = options.setTimer ?? processTimer;
	let timer: WatchTimer | undefined;
	const unlisten = () => {
		for (const { signal, listener } of listeners) signals.off(signal, listener);
	};
	const arm = (cause: string) => {
		unlisten();
		if (timer) return;
		options.onArm?.(cause);
		timer = setTimer(
			() => options.onSlow(cause, options.afterMs),
			options.afterMs,
		);
		timer.unref();
	};
	const listeners = ENDING_SIGNALS.map((signal) => {
		const listener = () => {
			arm(signal);
			if (signals.listenerCount(signal) === 0) options.raise?.(signal);
		};
		signals.on(signal, listener);
		return { signal, listener };
	});
	return {
		arm,
		stop: () => {
			timer?.clear();
			unlisten();
		},
	};
}

/**
 * An exit listener that ends a process exiting with a name lookup
 * pending: it calls `say` with what is still open, then `end`. A
 * process with none pending exits as it would have.
 */
export function endPastPendingLookup(options: {
	active: () => readonly string[];
	say: (active: readonly string[]) => void;
	end: () => void;
}): () => void {
	return () => {
		const active = options.active();
		if (!active.includes(PENDING_LOOKUP)) return;
		options.say(active);
		options.end();
	};
}

/** The process as `endNow` needs it: its pid, its TERM listeners, kill. */
export interface EndingProcess {
	pid: number;
	removeAllListeners(signal: string): unknown;
	kill(pid: number, signal: string): unknown;
}

/**
 * Ends the process at once, past an exit that would wait on a pending
 * name lookup: no exit path, `process.reallyExit` included, ends before
 * the threadpool's lookup returns, so only a signal's default action
 * does. It drops every TERM listener, pi's own handler among them, then
 * sends itself TERM, which ends it with status 143. The KILL after it
 * runs only when that TERM returns, which it does when TERM is blocked
 * or ignored, as a `SIG_IGN` inherited from `nohup` leaves it; without
 * the KILL the exit would go on waiting on the lookup.
 */
export function endNow(proc: EndingProcess): void {
	proc.removeAllListeners("SIGTERM");
	proc.kill(proc.pid, "SIGTERM");
	proc.kill(proc.pid, "SIGKILL");
}

/** The processes under `pid`, from every one of its threads. */
export function childrenOf(pid: number, proc = "/proc"): Child[] {
	let threads: string[];
	try {
		threads = readdirSync(join(proc, `${pid}`, "task"));
	} catch {
		// No proc to read, as on macOS: the record goes without children.
		return [];
	}
	const pids = threads.flatMap((thread) =>
		readOr(join(proc, `${pid}`, "task", thread, "children"))
			.split(/\s+/)
			.filter((field) => field !== "")
			.map(Number),
	);
	return pids.flatMap((child) => {
		const command = readOr(join(proc, `${child}`, "comm")).trim();
		return command === "" ? [] : [{ pid: child, command }];
	});
}

/** A file's text, or nothing where it can't be read. */
function readOr(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		// A thread or child that ended while it was being read.
		return "";
	}
}

/**
 * Writes the record of a slow end into `dir` and answers its path,
 * keeping only the newest hundred. It holds the end, what libuv holds
 * open and the process's resource use, never the environment, where
 * keys are. Nothing where it can't be written.
 */
export function writeSlowEnd(
	end: SlowEnd,
	dir: string,
	at = new Date(),
): string | undefined {
	const report = processReport();
	const record = {
		at: at.toISOString(),
		...end,
		handles: report?.libuv ?? [],
		resourceUsage: report?.resourceUsage,
	};
	const file = join(
		dir,
		`${at.toISOString().replaceAll(":", "-")}-${end.pid}.json`,
	);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
		prune(dir);
		return file;
	} catch {
		// A full or read-only disk loses the record; the line in the
		// journal still says what held the pi, and the exit goes on.
		return undefined;
	}
}

/** The parts of node's report the record asks for. */
interface ReportSettings {
	excludeNetwork?: boolean;
	getReport(): object;
}

/**
 * What node's diagnostic report says, in the parts the record keeps.
 * The report's network part looks up the host of every socket by
 * reverse DNS, which would block a dying pi whose network is gone, as
 * at a reboot, so it is left out: the handles still say each socket's
 * addresses.
 */
function processReport():
	| { libuv?: unknown; resourceUsage?: unknown }
	| undefined {
	// Node's types lag its report: excludeNetwork is there from Node 20.13.
	const reports: ReportSettings | undefined = process.report;
	if (!reports) return undefined;
	const excluded = reports.excludeNetwork;
	try {
		reports.excludeNetwork = true;
		const report = reports.getReport();
		if (typeof report !== "object" || report === null) return undefined;
		return {
			libuv: "libuv" in report ? report.libuv : undefined,
			resourceUsage:
				"resourceUsage" in report ? report.resourceUsage : undefined,
		};
	} catch {
		// A node without reports: the record keeps what pi itself saw.
		return undefined;
	} finally {
		reports.excludeNetwork = excluded;
	}
}

/** Removes all but the newest records in `dir`. */
function prune(dir: string): void {
	const records = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort();
	for (const name of records.slice(0, -KEPT_RECORDS))
		rmSync(join(dir, name), { force: true });
}

/**
 * The journal's line on a slow end: how long after what, the session,
 * what stays open, counting repeats, what runs under it, and where its
 * record is.
 */
export function slowEndLine(end: SlowEnd, file?: string): string {
	const parts = [
		`pi: still ending ${Math.round(end.afterMs)} ms after ${end.cause}, session ${end.session}`,
		...(end.held ? [`held: ${end.held}`] : []),
		`open: ${counted(end.active)}`,
		`children: ${
			end.children.length === 0
				? "none"
				: end.children.map((c) => `${c.pid} ${c.command}`).join(", ")
		}`,
	];
	if (file) parts.push(`report ${file}`);
	return parts.join("; ");
}

/** Names, each once in the order first seen, with ×N for repeats. */
function counted(names: readonly string[]): string {
	if (names.length === 0) return "none";
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts]
		.map(([name, n]) => (n === 1 ? name : `${name}×${n}`))
		.join(", ");
}
