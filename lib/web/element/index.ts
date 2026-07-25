/**
 * The element domain: the truth about one element.
 *
 * Analysis here is capture-agnostic. Everything takes plain
 * serializable data, so a box model read by CDP, by another
 * driver or from a fixture is read the same way.
 */

export {
	type BoxModel,
	centreOf,
	cornersOf,
	normalizeBoxModel,
	type Quad,
	type RawBoxModel,
	type Rect,
} from "./box.js";
export { OCCLUDER_PROBE } from "./probes.js";
export {
	renderBox,
	renderStyles,
	renderTrace,
	renderVisibility,
} from "./view.js";
export {
	judgeVisibility,
	type Viewport,
	type VisibilityFacts,
	type VisibilityVerdict,
	type Visible,
} from "./visibility.js";
