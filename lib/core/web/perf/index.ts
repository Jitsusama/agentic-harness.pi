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
	foldLayers,
	LAYER_ROUNDS,
	LAYER_SETTLE_MS,
	type LayerReport,
	nameNode,
	namesAnElement,
	type RawLayer,
	renderLayers,
} from "./layers.ts";
export {
	observerBootstrap,
	readVitalsSource,
} from "./probe.ts";
export {
	foldProfile,
	type Hotspots,
	type RawProfile,
	renderHotspots,
} from "./profile.ts";
export {
	categoriesFor,
	foldTrace,
	type RawTraceEvent,
	renderTrace,
	type TraceCapture,
	type TraceProfile,
} from "./trace.ts";
export { renderVitals } from "./view.ts";
export {
	measure,
	measureSamples,
	type Vitals,
} from "./vitals.ts";
