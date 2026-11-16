/**
 * What the page's own work costs: a sampled profile of its
 * JavaScript, a trace recorded around an action, and the heap
 * measured against the last time it was.
 *
 * Kept apart from the session because each of these switches on a
 * protocol domain for a window and folds what it collected, and
 * they change with what a performance question needs to see. The
 * trace shares the process's one recording permit with every other
 * session.
 */

import {
	categoriesFor,
	compareHeap,
	foldProfile,
	foldTrace,
	type HeapComparison,
	type HeapReading,
	type Hotspots,
	type RawProfile,
	type RawTraceEvent,
	type TraceCapture,
	type TraceProfile,
} from "../perf/index.ts";
import {
	claimRecording,
	type RecordingRefused,
	releaseRecording,
} from "./recording.ts";
import type { FrameTreeNode } from "./types.ts";
import type { SessionWires } from "./wires.ts";

/** Whether claiming the recording permit came back as a refusal. */
function isRecordingRefused(value: unknown): value is RecordingRefused {
	return typeof value === "object" && value !== null && "refusal" in value;
}

/** Profiles, traces and heap readings of one session's page. */
export class SessionProfiler {
	/** The live view of the browser the page is measured through. */
	private readonly wires: SessionWires;

	/** The session's name, which holds the recording permit. */
	private readonly name: string;

	constructor(wires: SessionWires, name: string) {
		this.wires = wires;
		this.name = name;
	}

	/**
	 * Record what the page's JavaScript is doing, for a while.
	 *
	 * A long task says three seconds went somewhere. This says
	 * where. The profiler is started, the page is left alone for
	 * the window asked for, and the samples are folded into time
	 * per function.
	 *
	 * Nothing is done to the page in between on purpose: whatever
	 * is being profiled has to be the page's own work, and a probe
	 * running during the window would appear in its own results.
	 */
	async profile(forMs: number): Promise<Hotspots> {
		await this.wires.ready();
		await this.wires.cdp().send("Profiler.enable");
		// A thousand microseconds is Chrome's own default. Sampling
		// faster buys precision the reader cannot use and costs the
		// page time that then shows up in its own profile.
		await this.wires
			.cdp()
			.send("Profiler.setSamplingInterval", { interval: 1000 });
		await this.wires.cdp().send("Profiler.start");
		await new Promise((wake) => setTimeout(wake, forMs));
		const { profile } = await this.wires.cdp().send("Profiler.stop");
		await this.wires.cdp().send("Profiler.disable");
		return foldProfile(profile as RawProfile);
	}

	/**
	 * Record a trace around some work, and say what it cost.
	 *
	 * The work runs inside the recording rather than before it,
	 * because a trace only holds what happened while it was on.
	 * Measured: a timer installed before the recording starts has
	 * no install event, so its lateness cannot be explained and a
	 * fetch begun earlier has no url. Tracing after the fact is
	 * not a weaker answer, it is no answer.
	 *
	 * The work's own result is handed back whatever the recording
	 * did, so a refused permit or a protocol failure costs the
	 * caller the trace and never the action.
	 */
	async recordWhile<T>(
		profiles: readonly TraceProfile[],
		work: () => Promise<T>,
	): Promise<{
		readonly result: T;
		readonly trace?: TraceCapture;
		readonly refusal?: string;
	}> {
		await this.wires.ready();
		const permit = claimRecording(this.name, profiles);
		if (isRecordingRefused(permit)) {
			return { result: await work(), refusal: permit.refusal };
		}

		const events: RawTraceEvent[] = [];
		const collect = (batch: { value?: RawTraceEvent[] }): void => {
			if (batch.value) events.push(...batch.value);
		};
		this.wires.cdp().on("Tracing.dataCollected", collect);

		let started = false;
		try {
			await this.wires.cdp().send("Tracing.start", {
				transferMode: "ReportEvents",
				traceConfig: {
					recordMode: "recordContinuously",
					includedCategories: [...categoriesFor(profiles)],
				},
			});
			started = true;
		} catch (error) {
			this.wires.cdp().off("Tracing.dataCollected", collect);
			releaseRecording();
			return {
				result: await work(),
				refusal: `The browser refused to start tracing: ${String(error)}`,
			};
		}

		// The action runs whatever the recording does next, and the
		// permit is given back on every path out of here.
		try {
			const result = await work();
			const delivered = new Promise<void>((resolve) => {
				this.wires.cdp().once("Tracing.tracingComplete", () => resolve());
			});
			await this.wires.cdp().send("Tracing.end");
			await delivered;
			return {
				result,
				trace: foldTrace(events, {
					frames: await this.ownFrameIds(),
					profiles,
				}),
			};
		} finally {
			this.wires.cdp().off("Tracing.dataCollected", collect);
			if (started) releaseRecording();
		}
	}

	/**
	 * Every frame id this session owns, its own and its children's.
	 *
	 * This is what separates our work from another session's in a
	 * recording that necessarily contains both.
	 */
	private async ownFrameIds(): Promise<ReadonlySet<string>> {
		const ids = new Set<string>();
		try {
			const { frameTree } = (await this.wires
				.cdp()
				.send("Page.getFrameTree")) as {
				frameTree: FrameTreeNode;
			};
			const queue: FrameTreeNode[] = [frameTree];
			while (queue.length > 0) {
				const node = queue.shift();
				if (node === undefined) continue;
				ids.add(node.frame.id);
				queue.push(...(node.childFrames ?? []));
			}
		} catch {
			// Without a frame tree nothing can be attributed, which the
			// fold reports as unattributed rather than guessing.
		}
		return ids;
	}

	/**
	 * Measure what the page is holding, against the last measurement.
	 *
	 * A collection is forced first unless refused, because a heap
	 * that grew means nothing while uncollected garbage is still in
	 * it. The previous reading is kept on the session so a caller
	 * can measure, do the thing they suspect, and measure again
	 * without having to carry a number between calls.
	 */
	async heap(collect = true): Promise<HeapComparison> {
		await this.wires.ready();

		if (collect) {
			// Chrome exposes this on two domains and neither is
			// guaranteed enabled. Failing to collect is not worth
			// failing the read over, but it does change what the
			// reading means, which is what `collected` carries.
			try {
				await this.wires.cdp().send("HeapProfiler.collectGarbage");
			} catch {
				collect = false;
			}
		}

		// The domain answers with an empty list until it is enabled,
		// which reads as a heap of zero that never changes: a leak
		// check that always says everything is fine. Enabling is
		// idempotent, so it costs nothing to do it on every read.
		// Measured: without this the domain answers with every metric
		// at zero rather than refusing, which reads as a page holding
		// no memory that never changes. A leak check that always says
		// everything is fine is worse than no leak check. Enabling is
		// idempotent, so it costs nothing to do on every read.
		await this.wires.cdp().send("Performance.enable");
		const { metrics } = await this.wires.cdp().send("Performance.getMetrics");
		const read = (named: string): number =>
			metrics.find((metric) => metric.name === named)?.value ?? 0;

		const reading: HeapReading = {
			usedBytes: read("JSHeapUsedSize"),
			totalBytes: read("JSHeapTotalSize"),
			collected: collect,
			at: Date.now(),
		};

		const compared = compareHeap(reading, this.lastHeap);
		this.lastHeap = reading;
		return compared;
	}

	/** The previous heap reading, for the next comparison. */
	private lastHeap?: HeapReading;
}
