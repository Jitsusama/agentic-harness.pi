/**
 * The element domain: the truth about one element.
 *
 * Analysis here is capture-agnostic. Everything takes plain
 * serializable data, so a box model read by CDP, by another
 * driver or from a fixture is read the same way.
 */

export {
	ANIMATIONS_PROBE,
	type Animation,
	normalizeAnimations,
	type RawAnimation,
	renderAnimations,
} from "./animations.js";
export {
	type BoxModel,
	centreOf,
	cornersOf,
	normalizeBoxModel,
	type Quad,
	type RawBoxModel,
	type Rect,
} from "./box.js";
export {
	type Listener,
	normalizeListeners,
	type RawListener,
	renderListeners,
} from "./listeners.js";
export { OCCLUDER_PROBE } from "./probes.js";
export {
	diffStyles,
	type PseudoState,
	type PseudoVariant,
	renderVariants,
	SETTLE_PROBE,
	type StyleChange,
} from "./pseudo.js";
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
