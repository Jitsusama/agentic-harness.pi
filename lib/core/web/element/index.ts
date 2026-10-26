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
} from "./actionable.ts";
export {
	ANIMATIONS_PROBE,
	type Animation,
	normalizeAnimations,
	type RawAnimation,
	renderAnimations,
} from "./animations.ts";
export {
	type BoxModel,
	centreOf,
	cornersOf,
	normalizeBoxModel,
	type Quad,
	type RawBoxModel,
	type Rect,
} from "./box.ts";
export {
	foldHover,
	HOVER_SCAN,
	type HoverGroup,
	type HoverMeasurement,
	type HoverReport,
	type HoverScan,
	MAX_HOVER_CANDIDATES,
	renderHover,
} from "./hover.ts";
export {
	ANCESTORS_PROBE,
	type DelegatedListeners,
	type Listener,
	normalizeListeners,
	type RawListener,
	renderListeners,
} from "./listeners.ts";
export {
	type AxisRelation,
	type Measurement,
	measureBetween,
	renderMeasurement,
} from "./measure.ts";
export {
	CONTENT_PROBE,
	HIDE_TEXT,
	OCCLUDER_PROBE,
	OWN_TEXT_PROBE,
	PAINTING_ELEMENT_PROBE,
	SELECT_TEXT_PROBE,
} from "./probes.ts";
export {
	diffStyles,
	type PseudoState,
	type PseudoVariant,
	renderVariants,
	SETTLE_PROBE,
	type StyleChange,
} from "./pseudo.ts";
export {
	renderBox,
	renderStyles,
	renderTrace,
	renderVisibility,
} from "./view.ts";
export {
	judgeVisibility,
	type Viewport,
	type VisibilityFacts,
	type VisibilityVerdict,
	type Visible,
} from "./visibility.ts";
