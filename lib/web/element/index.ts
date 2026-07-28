/**
 * The element domain: the truth about one element.
 *
 * Analysis here is capture-agnostic. Everything takes plain
 * serializable data, so a box model read by CDP, by another
 * driver or from a fixture is read the same way.
 */

export {
	type Actionability,
	type ActionabilityFacts,
	judgeActionability,
	sameBox,
} from "./actionable.js";
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
	foldHover,
	HOVER_SCAN,
	type HoverGroup,
	type HoverMeasurement,
	type HoverReport,
	type HoverScan,
	MAX_HOVER_CANDIDATES,
	renderHover,
} from "./hover.js";
export {
	ANCESTORS_PROBE,
	type DelegatedListeners,
	type Listener,
	normalizeListeners,
	type RawListener,
	renderListeners,
} from "./listeners.js";
export {
	type AxisRelation,
	type Measurement,
	measureBetween,
	renderMeasurement,
} from "./measure.js";
export {
	CONTENT_PROBE,
	HIDE_TEXT,
	OCCLUDER_PROBE,
	SELECT_TEXT_PROBE,
} from "./probes.js";
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
