/**
 * What a page cost the person waiting for it.
 *
 * The measurements come from the browser's performance
 * observers; the arithmetic over them is pure and works on any
 * capture, live or stored.
 */

export {
	compareHeap,
	type HeapComparison,
	type HeapReading,
	renderHeap,
} from "./heap.js";
export { observerBootstrap, readVitalsSource } from "./probe.js";
export {
	foldProfile,
	type Hotspot,
	type Hotspots,
	type RawProfile,
	type RawProfileNode,
	renderHotspots,
} from "./profile.js";
export {
	categoriesFor,
	type FrameStory,
	foldTrace,
	type RawTraceEvent,
	type RequestSpan,
	renderTrace,
	type TaskCost,
	type TimerStory,
	TRACE_CATEGORIES,
	type TraceCapture,
	type TraceProfile,
} from "./trace.js";
export { renderVitals } from "./view.js";
export {
	cumulativeShift,
	type LongTask,
	type Measure,
	measure,
	type Rating,
	rate,
	SESSION_CAP_MS,
	SESSION_GAP_MS,
	type Shift,
	THRESHOLDS,
	type Vitals,
	worstShiftSources,
} from "./vitals.js";
