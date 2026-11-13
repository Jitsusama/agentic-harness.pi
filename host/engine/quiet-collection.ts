/**
 * Giving V8's pooled pages back once the host goes quiet. V8 keeps the
 * pages a collection frees and unmaps them only on a memory-reducing
 * collection, which may not come for hours, so a host that served a day
 * of turns holds gigabytes its heap no longer uses (K7's measure: Pss
 * 460 to 940 MB fell to 205 to 240 after one).
 *
 * So once a turn ends, a conversation closes or one parks, the host runs
 * one last-resort collection, a pause of about a quarter second, when it
 * is quiet: no tool call or job running, and no viewer's key or resize
 * for VIEWER_QUIET_MS. A conversation mid-turn that is only waiting on
 * the model doesn't count against it, since the attended host almost
 * always has one, and the pause costs it at most a stall in streaming.
 * It runs at most once each SPACING_MS, and a park may bring one forward
 * inside that, since a park lets most of a conversation go at once. It
 * says the pause, the Pss before and after and how many conversations
 * were waiting on the model, and runs again only after something stirs.
 */
import { readFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/** How long after a viewer's last key or resize the host may pause. */
export const VIEWER_QUIET_MS = 30_000;

/** The least time between two collections, but for one a park brings forward. */
export const SPACING_MS = 10 * 60_000;

/**
 * How long after a stir the host looks, and how often it looks again
 * while a tool call or job runs: what a turn's end sets off runs first.
 */
export const SETTLE_MS = 5_000;

/** A pause longer than this is said as the loop held, as a late watchdog beat is. */
const HELD_MS = 1_000;

const MB = 1024 * 1024;
const KB = 1024;
const MS_PER_SECOND = 1000;

/** What runs one collection that gives pooled pages back. */
export type Collect = () => void;

/** What the host's conversations are doing, as far as a pause would cost them. */
export interface QuietReading {
	/** Tool calls and jobs running, in every conversation. */
	readonly working: number;
	/** Conversations mid-turn with no tool call running: waiting on the model. */
	readonly waiting: number;
}

/** What gives the host's pages back once it has been quiet. */
export interface QuietCollection {
	/** A turn started or ended, or a conversation closed: there is garbage to collect. */
	stirred(): void;
	/** A conversation parked: it may bring one collection forward. */
	parked(): void;
	/** A viewer pressed a key or resized: the host waits VIEWER_QUIET_MS from now. */
	viewed(): void;
	/** Collect no more. */
	stop(): void;
}

/** Collect when quiet, as the module says, from what `reading` answers. */
export function quietCollection(options: {
	readonly reading: () => QuietReading;
	readonly collect?: Collect;
	/** This process's Pss in bytes, or nothing where it can't be read. */
	readonly weigh?: () => number | undefined;
	readonly report?: (said: string) => void;
	/** What times the pause, in ms; performance.now by default. */
	readonly clock?: () => number;
}): QuietCollection {
	const collect = options.collect ?? lastResortCollect();
	const weigh = options.weigh ?? pssBytes;
	const clock = options.clock ?? (() => performance.now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	// Whether anything stirred since the last collection.
	let stirred = false;
	// Whether a park is owed a collection, and when one last ran for a park.
	let parkOwed = false;
	let lastForPark = Number.NEGATIVE_INFINITY;
	let lastCollected = Number.NEGATIVE_INFINITY;
	let lastViewed = Number.NEGATIVE_INFINITY;

	const forPark = (now: number) =>
		parkOwed && now - lastForPark >= SPACING_MS;
	const due = (now: number) =>
		Math.max(
			now + SETTLE_MS,
			lastViewed + VIEWER_QUIET_MS,
			forPark(now) ? now : lastCollected + SPACING_MS,
		);
	const arm = (at: number) => {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(look, Math.max(0, at - Date.now()));
		// A quiet host may still end: the wait never holds it up.
		timer.unref();
	};
	const look = () => {
		timer = undefined;
		if (!stirred && !parkOwed) return;
		const now = Date.now();
		const ready = Math.max(
			lastViewed + VIEWER_QUIET_MS,
			forPark(now) ? now : lastCollected + SPACING_MS,
		);
		if (ready > now) {
			arm(ready);
			return;
		}
		const reading = options.reading();
		if (reading.working > 0) {
			arm(now + SETTLE_MS);
			return;
		}
		if (forPark(now) && now - lastCollected < SPACING_MS) lastForPark = now;
		stirred = false;
		parkOwed = false;
		lastCollected = now;
		collected(reading);
	};
	const collected = (reading: QuietReading) => {
		const before = weigh();
		const started = clock();
		collect();
		const took = Math.round(clock() - started);
		const after = weigh();
		options.report?.(collectedLine(took, before, after, reading.waiting));
	};
	return {
		stirred() {
			stirred = true;
			arm(due(Date.now()));
		},
		parked() {
			parkOwed = true;
			arm(due(Date.now()));
		},
		viewed() {
			lastViewed = Date.now();
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/** The tool calls each conversation runs now, as its session's events say them. */
export interface RunningTools {
	/** Follow one of a conversation's session events. */
	heard(sessionId: string, event: string): void;
	/** How many tool calls the conversation runs now. */
	running(sessionId: string): number;
	/** The conversation has gone: forget it. */
	forget(sessionId: string): void;
}

/**
 * Count each conversation's tool calls from its session's events. A
 * run's end ends any whose own end an abort never said.
 */
export function runningTools(): RunningTools {
	const tools = new Map<string, number>();
	return {
		heard(sessionId, event) {
			const running = tools.get(sessionId) ?? 0;
			if (event === "tool_execution_start") tools.set(sessionId, running + 1);
			else if (event === "tool_execution_end" && running > 1)
				tools.set(sessionId, running - 1);
			else if (event === "tool_execution_end" || event === "agent_end")
				tools.delete(sessionId);
		},
		running: (sessionId) => tools.get(sessionId) ?? 0,
		forget: (sessionId) => {
			tools.delete(sessionId);
		},
	};
}

/** The journal's line for one collection. */
function collectedLine(
	took: number,
	before: number | undefined,
	after: number | undefined,
	waiting: number,
): string {
	const megabytes = (bytes: number) => `${Math.round(bytes / MB)} MB`;
	const pss =
		before === undefined || after === undefined
			? "Pss unread"
			: `Pss ${megabytes(before)} to ${megabytes(after)}`;
	const line = `Collected while quiet in ${took} ms, ${pss}, with ${waiting} conversations waiting on the model`;
	return took > HELD_MS
		? `${line}; the loop held ${(took / MS_PER_SECOND).toFixed(1)} s for it`
		: line;
}

/**
 * This process's proportional set size in bytes, from the kernel's
 * rollup of its mappings, or nothing where there is none to read.
 */
export function pssBytes(): number | undefined {
	try {
		const rollup = readFileSync("/proc/self/smaps_rollup", "utf8");
		const kb = /^Pss:\s+(\d+) kB$/m.exec(rollup)?.[1];
		return kb === undefined ? undefined : Number(kb) * KB;
	} catch {
		// Not Linux, or no procfs: the line says the Pss went unread.
		return undefined;
	}
}

/**
 * V8's gc, exposed for this process alone, run as a last-resort major
 * collection: the one kind that unmaps its pooled pages.
 */
export function lastResortCollect(): Collect {
	setFlagsFromString("--expose-gc");
	const gc: unknown = runInNewContext("gc");
	if (typeof gc !== "function")
		throw new Error("V8 exposed no gc to collect with");
	return () => gc({ type: "major", execution: "sync", flavor: "last-resort" });
}
