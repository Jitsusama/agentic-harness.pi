/**
 * Giving V8's pooled pages back once the host goes quiet. V8 keeps the
 * pages a collection frees and unmaps them only on a memory-reducing
 * collection, which may not come for hours, so a host that served a day
 * of turns holds gigabytes its heap no longer uses (K7's measure: Pss
 * 460 to 940 MB fell to 205 to 240 after one).
 *
 * So once a conversation's build settles, a turn ends, a conversation
 * closes or one parks, the host runs one last-resort collection, a
 * pause of about a quarter second on a fresh host, when it is quiet: no
 * tool call or job running, and no viewer's key or resize for
 * VIEWER_QUIET_MS. A conversation mid-turn that is only waiting on the
 * model doesn't count against it, since the attended host almost
 * always has one, and the pause costs it at most a stall in streaming.
 * It runs at most once each SPACING_MS, and a park may bring one forward
 * inside that, since a park lets most of a conversation go at once. It
 * says the pause, the Pss before and after and how many conversations
 * were waiting on the model, and runs again only after something stirs.
 * A host that always has a job running, as the background host nearly
 * always does, would never be quiet, so once a collection has been due
 * for CEILING_MS it runs with tool calls and jobs running, still only
 * once a viewer has been quiet, and says how many of each were: a
 * pause only stalls a job's child, whose pipe buffers meanwhile.
 * Where V8 exposes no gc, or its gc throws, it says so once and
 * collects nothing more, rather than keeping the host, and every
 * conversation in it, from starting or running.
 *
 * A build counts as a stir, since a child that only opened its
 * conversation otherwise kept its load's garbage for as long as it sat:
 * over 1100 MB, a heap of about 900 MB, in 7 of 101 runs of the child's
 * own test from 20 to 24 November. A build still running counts as
 * work, as a tool call does: a shared host resuming many at once would
 * otherwise pause the rest for the first one's garbage, and keep the
 * pace that pause measured beside builds as if it were its own.
 *
 * The pause grows with the heap a collection walks, about a second for
 * each GB the live hosts used, while what it gives back shrinks beside
 * it. So a collection due is left uncollected, and said, when the heap
 * it would walk, at the slowest pace of the last PACE_WINDOW, would hold
 * the loop past HELD_MS: a loop held that long stalls every conversation
 * and its viewer, which costs more than the pages it would give back.
 * One runs again once the heap has fallen within it.
 *
 * A child, which holds one conversation, forgets a pace PACE_KEPT_MS
 * after its collection, and with none kept the next look collects and
 * measures one afresh, as the first look does. The shared host keeps its
 * paces, since there a long pause stalls every conversation and viewer.
 * In a child it holds only that conversation, quiet as it is. A skip measures nothing, so one pause slowed by swap would
 * otherwise skip every later look while the heap only grew: on 21
 * November 19 children logged "Left uncollected" 31 times, holding a
 * mean of 265 MB each. Foretelling a nominal pace with none kept would
 * leave a large heap skipped for good in the same way, so none is.
 */
import { readFileSync } from "node:fs";
import {
	getHeapCodeStatistics,
	getHeapSpaceStatistics,
	setFlagsFromString,
} from "node:v8";
import { runInNewContext } from "node:vm";

/** How long after a viewer's last key or resize the host may pause. */
export const VIEWER_QUIET_MS = 30_000;

const MS_PER_MINUTE = 60_000;

/** The least time between two collections, but for one a park brings forward. */
export const SPACING_MS = 10 * MS_PER_MINUTE;

/**
 * How long after a stir the host looks, and how often it looks again
 * while a tool call or job runs: what a turn's end sets off runs first.
 */
export const SETTLE_MS = 5_000;

/** How long a collection may wait on running tool calls and jobs before it runs anyway. */
export const CEILING_MS = 60 * MS_PER_MINUTE;

/**
 * A pause longer than this is said as the loop held, as a late watchdog
 * beat is, and a collection foretold to take longer is left uncollected.
 */
const HELD_MS = 1_000;

/** How many of its last collections foretell the next one's pause, by the slowest. */
export const PACE_WINDOW = 4;

/** How long a collection's pace foretells the next, so a slow one can't rule for good. */
export const PACE_KEPT_MS = 60 * MS_PER_MINUTE;

const KB = 1024;
const MB = KB * KB;
const GB = KB * MB;
const MS_PER_SECOND = 1000;

/** What runs one collection that gives pooled pages back. */
export type Collect = () => void;

/** What the host's conversations are doing, as far as a pause would cost them. */
export interface QuietReading {
	/** Tool calls running, in every conversation. */
	readonly tools: number;
	/** Background jobs running or with results unsaid, in every conversation. */
	readonly jobs: number;
	/** Conversations mid-turn with no tool call running: waiting on the model. */
	readonly waiting: number;
	/** Conversations being built now, loading what they run on. */
	readonly builds: number;
}

/** What gives the host's pages back once it has been quiet. */
export interface QuietCollection {
	/** A conversation's build settled, a turn started or ended, or a conversation closed: there is garbage to collect. */
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
	/** What exposes V8's gc, where no `collect` is given; see lastResortCollect. */
	readonly exposeGc?: () => unknown;
	/** This process's Pss in bytes, or nothing where it can't be read. */
	readonly weigh?: () => number | undefined;
	/**
	 * V8's heap in bytes, used of what it holds, so a collection says how
	 * much of the Pss was JavaScript; the process's own by default, and
	 * nothing said where it answers nothing.
	 */
	readonly heap?: () => Heap | undefined;
	/**
	 * The code V8 holds, read once after each collection; the process's
	 * own by default, and nothing said where it answers nothing.
	 */
	readonly code?: () => HeapCode | undefined;
	readonly report?: (said: string) => void;
	/** What times the pause, in ms; performance.now by default. */
	readonly clock?: () => number;
	/**
	 * Whether a pace is forgotten PACE_KEPT_MS after its collection, as a
	 * child holding one conversation does; the shared host keeps them.
	 */
	readonly forgetsPaces?: boolean;
}): QuietCollection {
	const collect = options.collect ?? lastResortCollect(options.exposeGc);
	if (!collect) {
		options.report?.(
			"V8 exposed no gc to collect with, so the host won't collect when quiet",
		);
		return { stirred() {}, parked() {}, viewed() {}, stop() {} };
	}
	const weigh = options.weigh ?? pssBytes;
	const heap = options.heap ?? processHeap;
	const code = options.code ?? processCode;
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
	// Since when a collection has been due but held off by running work.
	let dueSince: number | undefined;
	// The last collections' pauses, in ms for each byte of heap they
	// walked, and when each ran.
	const paces: { readonly pace: number; readonly at: number }[] = [];

	const forPark = (now: number) => parkOwed && now - lastForPark >= SPACING_MS;
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
		// Each on its own, so a count gone wrong can't cancel another out.
		const working = reading.tools > 0 || reading.jobs > 0 || reading.builds > 0;
		dueSince ??= now;
		if (working && now - dueSince < CEILING_MS) {
			arm(Math.min(now + SETTLE_MS, dueSince + CEILING_MS));
			return;
		}
		if (forPark(now) && now - lastCollected < SPACING_MS) lastForPark = now;
		stirred = false;
		parkOwed = false;
		dueSince = undefined;
		lastCollected = now;
		const heapBefore = heap();
		while (
			options.forgetsPaces &&
			paces[0] &&
			now - paces[0].at >= PACE_KEPT_MS
		)
			paces.shift();
		const pace =
			paces.length > 0 ? Math.max(...paces.map((one) => one.pace)) : undefined;
		if (
			heapBefore !== undefined &&
			pace !== undefined &&
			pace * heapBefore.used > HELD_MS
		) {
			options.report?.(
				uncollectedLine(heapBefore, { pace, paced: paces.length }, reading),
			);
			return;
		}
		collected(reading, working, heapBefore, now);
	};
	const collected = (
		reading: QuietReading,
		working: boolean,
		heapBefore: Heap | undefined,
		now: number,
	) => {
		const before = weigh();
		const started = clock();
		try {
			collect();
		} catch (error) {
			// In a timer, a throw would reach the process with no
			// conversation to blame, so it is said once and collection ends.
			stopped = true;
			const why = error instanceof Error ? error.message : String(error);
			options.report?.(
				`V8's gc threw (${why}), so the host won't collect when quiet`,
			);
			return;
		}
		// The code is counted by a walk of the heap, so it is read inside the
		// pause's time, where the pace that spares a large heap counts it,
		// and its own part is timed too.
		const codeFrom = clock();
		const heldCode = code();
		const ended = clock();
		const codeRead = heldCode && {
			...heldCode,
			took: Math.round(ended - codeFrom),
		};
		const took = Math.round(ended - started);
		if (heapBefore !== undefined && heapBefore.used > 0) {
			paces.push({ pace: took / heapBefore.used, at: now });
			if (paces.length > PACE_WINDOW) paces.shift();
		}
		const after = weigh();
		const heaps = { before: heapBefore, after: heap() };
		options.report?.(
			collectedLine(took, { before, after }, heaps, codeRead, reading, working),
		);
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

/** One space of V8's heap: what it uses of what it holds, in bytes. */
interface HeapSpace {
	/** V8's name for it, such as old_space. */
	readonly name: string;
	readonly used: number;
	readonly size: number;
}

/**
 * V8's heap: what it uses of what it holds, each space it keeps, and the
 * memory V8 holds for JavaScript outside it, with the array buffers among
 * that, all in bytes.
 */
export interface Heap {
	readonly used: number;
	readonly total: number;
	readonly external: number;
	readonly arrayBuffers: number;
	readonly spaces: readonly HeapSpace[];
}

/**
 * The code V8 holds, in bytes: compiled code and its metadata, bytecode
 * and its metadata, and the source of scripts kept as external strings.
 * V8 counts only those there, which in node are its own built-in
 * modules, not the source a module loader reads from disk, so it moves
 * only as built-ins are loaded. Bytecode that grows beside compiled code
 * says new source is being compiled; compiled code growing alone says
 * optimisation. The live host's code space grew from 5 to 147 MB by 17
 * November, and a soak of reloads and resumes grew it by none of that,
 * so this says which of the two it was.
 */
export interface HeapCode {
	readonly compiled: number;
	readonly bytecode: number;
	readonly source: number;
}

/** This process's V8 heap, read from counters V8 keeps, with no pause. */
export function processHeap(): Heap {
	const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
	return {
		used: heapUsed,
		total: heapTotal,
		external,
		arrayBuffers,
		spaces: getHeapSpaceStatistics().map((space) => ({
			name: space.space_name,
			used: space.space_used_size,
			size: space.space_size,
		})),
	};
}

/**
 * The code this process's V8 holds. V8 counts it by walking the objects
 * of its code and old spaces, a pause that grows with the heap, so it is
 * read only after a collection the host already chose to pause for.
 */
export function processCode(): HeapCode {
	const code = getHeapCodeStatistics();
	return {
		compiled: code.code_and_metadata_size,
		bytecode: code.bytecode_and_metadata_size,
		source: code.external_script_source_size,
	};
}

/**
 * The code held and how long reading it took, as `code and metadata 18
 * MB, bytecode 6 MB, external script source 25 MB, read in 40 ms`.
 */
function codeSaid(code: HeapCode & { readonly took: number }): string {
	const megabytes = (bytes: number) => `${Math.round(bytes / MB)} MB`;
	return `code and metadata ${megabytes(code.compiled)}, bytecode ${megabytes(code.bytecode)}, external script source ${megabytes(code.source)}, read in ${code.took} ms`;
}

/** Each space of at least a megabyte, as `old 100 of 120 MB`. */
function spacesSaid(spaces: readonly HeapSpace[]): string {
	return spaces
		.filter((space) => space.size >= MB)
		.map(
			(space) =>
				`${space.name.replace(/_space$/, "").replaceAll("_", " ")} ${Math.round(space.used / MB)} of ${Math.round(space.size / MB)} MB`,
		)
		.join(", ");
}

/** The journal's line for one collection. */
function collectedLine(
	took: number,
	pssAround: { readonly before?: number; readonly after?: number },
	heapAround: { readonly before?: Heap; readonly after?: Heap },
	code: (HeapCode & { readonly took: number }) | undefined,
	reading: QuietReading,
	working: boolean,
): string {
	const megabytes = (bytes: number) => `${Math.round(bytes / MB)} MB`;
	const { before, after } = pssAround;
	const pss =
		before === undefined || after === undefined
			? "Pss unread"
			: `Pss ${megabytes(before)} to ${megabytes(after)}`;
	const held = (one: Heap) =>
		`${Math.round(one.used / MB)} of ${megabytes(one.total)}`;
	const heap =
		heapAround.before && heapAround.after
			? `, heap ${held(heapAround.before)} to ${held(heapAround.after)} (${spacesSaid(heapAround.after.spaces)}), outside it ${megabytes(heapAround.before.external)} to ${megabytes(heapAround.after.external)}, of which array buffers ${megabytes(heapAround.before.arrayBuffers)} to ${megabytes(heapAround.after.arrayBuffers)}`
			: "";
	const coded = code ? `, ${codeSaid(code)}` : "";
	const quiet = `Collected while quiet in ${took} ms, ${pss}${heap}${coded}, with ${reading.waiting} conversations waiting on the model`;
	const line = working
		? `${quiet}, and ${reading.tools} tool calls, ${reading.jobs} jobs and ${reading.builds} builds running, due for ${CEILING_MS / MS_PER_MINUTE} minutes`
		: quiet;
	return took > HELD_MS
		? `${line}; the loop held ${(took / MS_PER_SECOND).toFixed(1)} s for it`
		: line;
}

/**
 * The journal's line for a collection left uncollected, its pause
 * foretold at `pace` ms a byte, the slowest of the last `paced`.
 */
function uncollectedLine(
	heap: Heap,
	foretelling: { readonly pace: number; readonly paced: number },
	reading: QuietReading,
): string {
	const { pace, paced } = foretelling;
	const seconds = ((pace * heap.used) / MS_PER_SECOND).toFixed(1);
	return `Left uncollected while quiet: the heap uses ${Math.round(heap.used / MB)} MB, which at ${Math.round(pace * GB)} ms a GB, the slowest of the last ${paced} collections, would hold the loop about ${seconds} s, past the ${HELD_MS / MS_PER_SECOND} s a pause may take; with ${reading.waiting} conversations waiting on the model`;
}

/**
 * A process's proportional set size in bytes, this one's unless `pid`
 * names another, from the kernel's rollup of its mappings, or nothing
 * where there is none to read: no procfs, or no such process.
 */
export function pssBytes(pid?: number): number | undefined {
	try {
		const rollup = readFileSync(`/proc/${pid ?? "self"}/smaps_rollup`, "utf8");
		const kb = /^Pss:\s+(\d+) kB$/m.exec(rollup)?.[1];
		return kb === undefined ? undefined : Number(kb) * KB;
	} catch {
		// Not Linux, no procfs or no such process: the Pss goes unread.
		return undefined;
	}
}

/**
 * V8's gc, exposed for this process alone, run as a last-resort major
 * collection: the one kind that unmaps its pooled pages. Nothing where
 * `expose` gives no gc or throws, as a V8 that drops the flag would.
 */
export function lastResortCollect(
	expose: () => unknown = exposedGc,
): Collect | undefined {
	let gc: unknown;
	try {
		gc = expose();
	} catch {
		// A V8 that refuses the flag or the context: the caller says so.
		return undefined;
	}
	if (typeof gc !== "function") return undefined;
	return () => gc({ type: "major", execution: "sync", flavor: "last-resort" });
}

/** V8's gc, from a new context once the flag that exposes it is set. */
function exposedGc(): unknown {
	setFlagsFromString("--expose-gc");
	return runInNewContext("gc");
}
