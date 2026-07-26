/**
 * What a page cost the person waiting for it.
 *
 * The measurements come from the browser's performance
 * observers; the arithmetic over them is pure and works on any
 * capture, live or stored.
 */

export { observerBootstrap, readVitalsSource } from "./probe.js";
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
