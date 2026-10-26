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
} from "./heap.ts";
export {
	BYTES_PER_PIXEL,
	type CompositedLayer,
	foldLayers,
	LAYER_SETTLE_MS,
	type LayerFacts,
	type LayerReport,
	nameNode,
	type RawLayer,
	type ReasonTally,
	renderLayers,
} from "./layers.ts";
export { observerBootstrap, readVitalsSource } from "./probe.ts";
export {
	foldProfile,
	type Hotspot,
	type Hotspots,
	type RawProfile,
	type RawProfileNode,
	renderHotspots,
} from "./profile.ts";
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
} from "./trace.ts";
export { renderVitals } from "./view.ts";
export {
	cumulativeShift,
	type LongTask,
	type Measure,
	measure,
	measureSamples,
	type Rating,
	rate,
	SESSION_CAP_MS,
	SESSION_GAP_MS,
	type Shift,
	type Spread,
	THRESHOLDS,
	type Vitals,
	worstShiftSources,
} from "./vitals.ts";
