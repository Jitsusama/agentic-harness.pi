/**
 * Raw input: chords, pointer gestures and touch gestures.
 *
 * Everything here is pure composition. A gesture is described as
 * the ordered events a real hand would produce, and dispatching
 * them is the session's job, so the shape of an interaction can
 * be checked without a browser.
 */

export {
	type Chord,
	type ChordRefusal,
	MODIFIER_BITS,
	type ModifierName,
	parseChords,
} from "./keys.js";
export {
	composeClick,
	composeDrag,
	type DragOptions,
	interpolate,
	type MouseButton,
	type Point,
	type PointerEventStep,
	ratios,
} from "./pointer.js";
export {
	composeLongPress,
	composePinch,
	composeSwipe,
	composeTap,
	LONG_PRESS_MS,
	type TouchPoint,
	type TouchStep,
} from "./touch.js";
