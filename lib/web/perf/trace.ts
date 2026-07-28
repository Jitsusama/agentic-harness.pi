/**
 * What the page was doing, and what caused what.
 *
 * A profile says which functions the time went into. It cannot say
 * that a click installed a timer, that the timer fired forty
 * milliseconds late, or that two fetches were in flight together
 * and the second answered first. Those are questions about order
 * and causation rather than cost, and the only place the browser
 * answers them is its own trace stream.
 *
 * A trace is a recording rather than a recorder. Chrome hands
 * nothing over while it runs and delivers everything in a burst
 * when it stops, which is measured and is why this module folds a
 * finished capture rather than following a live one.
 *
 * Two things about the stream shape are worth knowing before
 * reading the code. Timestamps and durations are microseconds.
 * And only some events say which frame they belong to: resource
 * events carry a request id instead, and frame-pipeline events
 * carry a layer tree, so placing those takes a join and a
 * process, not a lookup.
 */

/** One event as the tracing protocol sends it. */
export interface RawTraceEvent {
	readonly name: string;
	readonly cat?: string;
	/** Phase: X complete, I instant, b and e async pairs, M metadata. */
	readonly ph: string;
	/** Microseconds on the trace clock. */
	readonly ts: number;
	/** Microseconds, on complete events only. */
	readonly dur?: number;
	readonly pid: number;
	readonly tid: number;
	readonly id2?: { readonly local?: string };
	readonly args?: Record<string, unknown>;
}

/** Which story a recording is being asked to tell. */
export type TraceProfile = "async" | "frames";

/**
 * The categories each profile turns on.
 *
 * Naming no categories is never right: measured, the default set
 * costs about five megabytes a second and is almost entirely
 * Chrome talking to itself about mojo messages and task queues.
 * The sets below are the page's own story, at about sixty
 * kilobytes a second for async and three hundred and forty with
 * frames.
 */
export const TRACE_CATEGORIES: Record<TraceProfile, readonly string[]> = {
	async: ["devtools.timeline", "v8.execute", "latencyInfo"],
	frames: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame"],
};

/** The categories to ask for, with nothing repeated. */
export function categoriesFor(
	profiles: readonly TraceProfile[],
): readonly string[] {
	const wanted = new Set<string>();
	for (const profile of profiles) {
		for (const category of TRACE_CATEGORIES[profile]) wanted.add(category);
	}
	return [...wanted];
}

/** One kind of work and the time that landed in it. */
export interface TaskCost {
	readonly name: string;
	readonly count: number;
	readonly totalMs: number;
	readonly longestMs: number;
}

/** A timer, from the moment it was asked for to the moment it ran. */
export interface TimerStory {
	readonly timerId: number;
	readonly timeoutMs: number;
	readonly singleShot: boolean;
	/** Milliseconds from the start of the recording. */
	readonly installedAtMs: number;
	readonly firedAtMs?: number;
	/** How long the callback itself took. */
	readonly ranForMs?: number;
	/**
	 * How much later than asked it fired, never below zero. For a
	 * repeating timer this is the worst delay between consecutive
	 * fires, since an interval is a promise about the gap.
	 */
	readonly lateByMs?: number;
	/** How many times it fired inside the recording. */
	readonly firedCount: number;
}

/** A request, from the moment it left to the moment it settled. */
export interface RequestSpan {
	readonly requestId: string;
	readonly url?: string;
	readonly method?: string;
	readonly resourceType?: string;
	readonly status?: number;
	readonly sentAtMs: number;
	readonly respondedAtMs?: number;
	readonly finishedAtMs?: number;
	readonly failed?: boolean;
}

/**
 * What the compositor did.
 *
 * These figures belong to a renderer process rather than to one
 * page, and that cannot be narrowed from a trace. The frame
 * pipeline names a layer tree host, never a frame, and measured
 * against this Chrome no event carries both: `SetLayerTreeId`, which
 * used to join them, is gone, and a search across a two page
 * capture found nothing else linking the two.
 *
 * So instead of repeating a blanket disclaimer, `layerTrees` says
 * how many hosts actually contributed. One means the figures came
 * from a single layer tree and are this page's for any practical
 * purpose; more than one means another page or another tree in the
 * same process is in the numbers. Zero means the begin events
 * carried no host id, so the question went unanswered, which is not
 * the same as the answer being one.
 */
export interface FrameStory {
	readonly counted: number;
	readonly longestMs: number;
	/** Every frame that missed the sixty-a-second budget. */
	readonly slowMs: readonly number[];
	/** Distinct compositor layer tree hosts behind these figures. */
	readonly layerTrees: number;
}

/** What a finished recording says. */
export interface TraceCapture {
	readonly profiles: readonly TraceProfile[];
	readonly spanMs: number;
	/** Events received, before any attribution. */
	readonly events: number;
	/** Events placed with this session. */
	readonly mine: number;
	/** Events that named neither our frames nor our process. */
	readonly unattributed: number;
	readonly tasks: readonly TaskCost[];
	readonly timers: readonly TimerStory[];
	readonly requests: readonly RequestSpan[];
	readonly overlapping: number;
	readonly resolvedOutOfOrder: boolean;
	readonly frames?: FrameStory;
}

/** Sixteen milliseconds is the budget for sixty frames a second. */
const FRAME_BUDGET_MS = 1000 / 60;

/** How many kinds of work to name before it is a data dump. */
const TOP_TASKS = 12;

const US_PER_MS = 1000;

/** Microseconds to milliseconds, rounded to whole milliseconds. */
const ms = (microseconds: number): number =>
	Math.round(microseconds / US_PER_MS);

/** The payload most devtools.timeline events hang their fields on. */
function dataOf(event: RawTraceEvent): Record<string, unknown> | undefined {
	const data = event.args?.data;
	return typeof data === "object" && data !== null
		? (data as Record<string, unknown>)
		: undefined;
}

function stringField(
	data: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = data?.[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(
	data: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = data?.[key];
	return typeof value === "number" ? value : undefined;
}

/** Which frame an event names, when it names one at all. */
function frameOf(event: RawTraceEvent): string | undefined {
	return stringField(dataOf(event), "frame");
}

/**
 * Fold a finished recording into what it says.
 *
 * Attribution runs in two passes because the first pass is what
 * makes the second possible: events that name one of our frames
 * reveal which renderer process we are in, and that process is
 * the only handle on the frame-pipeline events, which name no
 * frame at all. Anything left is counted rather than guessed,
 * because a report that quietly adopts another page's work is
 * worse than one that admits a gap.
 */
export function foldTrace(
	events: readonly RawTraceEvent[],
	options: {
		readonly frames: ReadonlySet<string>;
		readonly profiles: readonly TraceProfile[];
	},
): TraceCapture {
	const wantsFrames = options.profiles.includes("frames");

	const myPids = new Set<number>();
	for (const event of events) {
		const frame = frameOf(event);
		if (frame !== undefined && options.frames.has(frame)) myPids.add(event.pid);
	}

	// Resource events name a request rather than a frame, so the
	// send is what places the whole span and the rest follow it.
	const requestFrames = new Map<string, string>();
	for (const event of events) {
		if (event.name !== "ResourceSendRequest") continue;
		const data = dataOf(event);
		const id = stringField(data, "requestId");
		const frame = stringField(data, "frame");
		if (id !== undefined && frame !== undefined) requestFrames.set(id, frame);
	}

	const isMine = (event: RawTraceEvent): boolean | undefined => {
		const frame = frameOf(event);
		if (frame !== undefined) return options.frames.has(frame);
		const requestId = stringField(dataOf(event), "requestId");
		if (requestId !== undefined) {
			const owner = requestFrames.get(requestId);
			if (owner !== undefined) return options.frames.has(owner);
			return undefined;
		}
		if (myPids.has(event.pid)) return true;
		return undefined;
	};

	let mine = 0;
	let unattributed = 0;
	let firstUs = Number.POSITIVE_INFINITY;
	let lastUs = Number.NEGATIVE_INFINITY;
	const ours: RawTraceEvent[] = [];
	for (const event of events) {
		if (event.ph === "M") continue;
		const verdict = isMine(event);
		if (verdict === undefined) unattributed += 1;
		else if (verdict) {
			mine += 1;
			ours.push(event);
			firstUs = Math.min(firstUs, event.ts);
			lastUs = Math.max(lastUs, event.ts + (event.dur ?? 0));
		}
	}

	const startUs = Number.isFinite(firstUs) ? firstUs : 0;
	const at = (microseconds: number): number => ms(microseconds - startUs);

	return {
		profiles: options.profiles,
		spanMs: Number.isFinite(firstUs) ? ms(lastUs - firstUs) : 0,
		events: events.length,
		mine,
		unattributed,
		tasks: foldTasks(ours),
		timers: foldTimers(ours, at),
		...foldRequests(ours, at),
		frames: wantsFrames ? foldFrames(ours) : undefined,
	};
}

/** Total the complete events by kind, dearest first. */
function foldTasks(events: readonly RawTraceEvent[]): readonly TaskCost[] {
	const totals = new Map<
		string,
		{ count: number; total: number; max: number }
	>();
	for (const event of events) {
		if (event.ph !== "X" || event.dur === undefined) continue;
		const seen = totals.get(event.name) ?? { count: 0, total: 0, max: 0 };
		seen.count += 1;
		seen.total += event.dur;
		seen.max = Math.max(seen.max, event.dur);
		totals.set(event.name, seen);
	}
	return [...totals.entries()]
		.map(([name, seen]) => ({
			name,
			count: seen.count,
			totalMs: ms(seen.total),
			longestMs: ms(seen.max),
		}))
		.sort((one, other) => other.totalMs - one.totalMs)
		.slice(0, TOP_TASKS);
}

/**
 * Pair each install with the fire that belongs to it.
 *
 * Chrome recycles timer ids within a frame, so an id is not an
 * identity. Pairing keeps only the most recent live install for
 * an id and drops it on removal, because keyed naively a recycled
 * id blames a fire on a long-dead install and reports a lateness
 * of several seconds that never happened.
 */
function foldTimers(
	events: readonly RawTraceEvent[],
	at: (us: number) => number,
): readonly TimerStory[] {
	/** Where each live timer's story sits, so a fire can revise it. */
	const live = new Map<string, number>();
	const stories: TimerStory[] = [];
	const key = (frame: string | undefined, id: number): string =>
		`${frame ?? "?"}#${id}`;

	for (const event of events) {
		const data = dataOf(event);
		const id = numberField(data, "timerId");
		if (id === undefined) continue;
		const frame = stringField(data, "frame");

		if (event.name === "TimerInstall") {
			const story: TimerStory = {
				timerId: id,
				timeoutMs: numberField(data, "timeout") ?? 0,
				singleShot: data?.singleShot === true,
				installedAtMs: at(event.ts),
				firedCount: 0,
			};
			live.set(key(frame, id), stories.length);
			stories.push(story);
			continue;
		}

		if (event.name === "TimerRemove") {
			live.delete(key(frame, id));
			continue;
		}

		if (event.name !== "TimerFire") continue;
		const slot = live.get(key(frame, id));
		if (slot === undefined) continue;
		const install = stories[slot];
		const firedAtMs = at(event.ts);
		// A repeating timer keeps an interval, so what it promised is
		// about the gap since it last ran. Measured from the install
		// instead, a punctual interval looks later on every fire.
		const since = install.firedAtMs ?? install.installedAtMs;
		const lateBy = Math.max(0, firedAtMs - since - install.timeoutMs);
		stories[slot] = {
			...install,
			firedAtMs,
			firedCount: install.firedCount + 1,
			ranForMs: event.dur === undefined ? undefined : ms(event.dur),
			lateByMs: Math.max(install.lateByMs ?? 0, lateBy),
		};
		if (install.singleShot) live.delete(key(frame, id));
	}

	return stories;
}

/** Join request events by id, and say what the overlap was. */
function foldRequests(
	events: readonly RawTraceEvent[],
	at: (us: number) => number,
): {
	requests: readonly RequestSpan[];
	overlapping: number;
	resolvedOutOfOrder: boolean;
} {
	const spans = new Map<string, RequestSpan>();
	for (const event of events) {
		const data = dataOf(event);
		const id = stringField(data, "requestId");
		if (id === undefined) continue;

		if (event.name === "ResourceSendRequest") {
			spans.set(id, {
				requestId: id,
				url: stringField(data, "url"),
				method: stringField(data, "requestMethod"),
				resourceType: stringField(data, "resourceType"),
				sentAtMs: at(event.ts),
			});
			continue;
		}

		const span = spans.get(id);
		if (span === undefined) continue;

		if (event.name === "ResourceReceiveResponse") {
			spans.set(id, {
				...span,
				status: numberField(data, "statusCode"),
				respondedAtMs: at(event.ts),
			});
		} else if (event.name === "ResourceFinish") {
			spans.set(id, {
				...span,
				finishedAtMs: at(event.ts),
				failed: data?.didFail === true,
			});
		}
	}

	const requests = [...spans.values()].sort(
		(one, other) => one.sentAtMs - other.sentAtMs,
	);

	// A sweep over starts and ends gives the most in flight at once.
	const edges: { atMs: number; delta: number }[] = [];
	for (const request of requests) {
		edges.push({ atMs: request.sentAtMs, delta: 1 });
		edges.push({
			atMs: request.finishedAtMs ?? Number.POSITIVE_INFINITY,
			delta: -1,
		});
	}
	edges.sort((one, other) => one.atMs - other.atMs || one.delta - other.delta);
	let inFlight = 0;
	let overlapping = 0;
	for (const edge of edges) {
		inFlight += edge.delta;
		overlapping = Math.max(overlapping, inFlight);
	}

	// Sent first but settled last is the fact that explains a
	// waterfall nobody expected.
	let resolvedOutOfOrder = false;
	const settled = requests.filter((one) => one.finishedAtMs !== undefined);
	for (let index = 1; index < settled.length; index += 1) {
		const previous = settled[index - 1].finishedAtMs ?? 0;
		if ((settled[index].finishedAtMs ?? 0) < previous) {
			resolvedOutOfOrder = true;
			break;
		}
	}

	return { requests, overlapping, resolvedOutOfOrder };
}

/** Which layer tree host a pipeline event names, if any. */
function layerTreeHostOf(event: RawTraceEvent): number | undefined {
	const reporter = event.args?.frame_reporter;
	if (typeof reporter !== "object" || reporter === null) return undefined;
	const host = (reporter as Record<string, unknown>).layer_tree_host_id;
	return typeof host === "number" ? host : undefined;
}

/**
 * Time each frame from its paired begin and end.
 *
 * Only the begin event carries the layer tree host, the end event
 * having empty args, so the host is banked on the way in and read
 * back when the pair closes. Measured across 414 pairs, a begin is
 * always closed by the next end for its id, so no pair is lost to
 * an id being reused for a different tree.
 */
function foldFrames(events: readonly RawTraceEvent[]): FrameStory {
	const opened = new Map<string, { at: number; host?: number }>();
	const durations: number[] = [];
	const hosts = new Set<number>();
	for (const event of events) {
		if (event.name !== "PipelineReporter") continue;
		const id = event.id2?.local;
		if (id === undefined) continue;
		if (event.ph === "b") {
			const host = layerTreeHostOf(event);
			opened.set(id, { at: event.ts, ...(host === undefined ? {} : { host }) });
		} else if (event.ph === "e") {
			const began = opened.get(id);
			if (began === undefined) continue;
			opened.delete(id);
			durations.push(ms(event.ts - began.at));
			// Counted only for a frame that closed, so the tally covers
			// exactly the frames the figures are built from.
			if (began.host !== undefined) hosts.add(began.host);
		}
	}
	return {
		counted: durations.length,
		longestMs: durations.length === 0 ? 0 : Math.max(...durations),
		slowMs: durations.filter((each) => each > FRAME_BUDGET_MS),
		layerTrees: hosts.size,
	};
}

/**
 * Whose frames these are, said as precisely as the trace allows.
 *
 * A trace cannot tie a layer tree to a frame, so this cannot always
 * be narrowed to one page. What it can do is stop hedging when
 * there is nothing to hedge about: a single contributing layer tree
 * means nothing else was in the numbers.
 */
function whoseFrames(frames: FrameStory): readonly string[] {
	if (frames.layerTrees === 1) {
		return [
			"  One compositor layer tree produced all of them, so these are",
			"  this page's frames.",
		];
	}
	if (frames.layerTrees > 1) {
		return [
			`  ${frames.layerTrees} compositor layer trees produced them, so`,
			"  another page or tree in this renderer process is counted here",
			"  too. Nothing in a trace ties a layer tree to a frame, so they",
			"  cannot be told apart.",
		];
	}
	return [
		"  The pipeline events named no layer tree, so whether another",
		"  page in this renderer process is counted here is unknown.",
	];
}

/** Say what the recording found, in the order a reader needs it. */
export function renderTrace(capture: TraceCapture): string {
	if (capture.mine === 0) {
		return "Nothing was recorded for this page.";
	}

	const lines: string[] = [
		`Recorded ${capture.spanMs}ms across ${capture.mine} events ` +
			`(${capture.profiles.join(" and ")}).`,
	];

	if (capture.tasks.length > 0) {
		lines.push("", "Where the time went:");
		for (const task of capture.tasks) {
			lines.push(
				`  ${task.name}: ${task.totalMs}ms over ${task.count}, ` +
					`longest ${task.longestMs}ms`,
			);
		}
	}

	const late = capture.timers.filter((each) => (each.lateByMs ?? 0) > 0);
	if (late.length > 0) {
		lines.push("", "Timers that did not run when they were asked to:");
		for (const timer of late) {
			lines.push(
				`  asked for ${timer.timeoutMs}ms, fired ${timer.lateByMs}ms late`,
			);
		}
	}

	const pending = capture.timers.filter((each) => each.firedAtMs === undefined);
	if (pending.length > 0) {
		lines.push(
			"",
			`${pending.length} timer${pending.length === 1 ? "" : "s"} ` +
				"installed but still waiting when the recording stopped.",
		);
	}

	if (capture.requests.length > 0) {
		lines.push(
			"",
			`${capture.requests.length} request${capture.requests.length === 1 ? "" : "s"}, ` +
				`at most ${capture.overlapping} in flight at once:`,
		);
		for (const request of capture.requests) {
			const settled =
				request.finishedAtMs === undefined
					? "never settled"
					: `settled ${request.finishedAtMs}ms`;
			lines.push(
				`  ${request.sentAtMs}ms ${request.method ?? "?"} ` +
					`${request.url ?? request.requestId} -> ` +
					`${request.status ?? (request.failed ? "failed" : "?")}, ${settled}`,
			);
		}
		if (capture.resolvedOutOfOrder) {
			lines.push(
				"  One of these settled before a request sent earlier, so the",
				"  order they answered in is not the order they were made.",
			);
		}
	}

	if (capture.frames !== undefined && capture.frames.counted > 0) {
		const frames = capture.frames;
		lines.push(
			"",
			`${frames.counted} frames, longest ${frames.longestMs}ms, ` +
				`${frames.slowMs.length} over the 16ms budget.`,
			...whoseFrames(frames),
		);
	}

	if (capture.unattributed > 0) {
		lines.push(
			"",
			`${capture.unattributed} events named neither our frames nor our`,
			"process and were left out rather than guessed at.",
		);
	}

	return lines.join("\n");
}
