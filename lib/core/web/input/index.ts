/**
 * Raw input: chords, pointer gestures and touch gestures.
 *
 * Everything here is pure composition. A gesture is described as
 * the ordered events a real hand would produce, and dispatching
 * them is the session's job, so the shape of an interaction can
 * be checked without a browser.
 */

export {
	type ChordRefusal,
	parseChords,
} from "./keys.ts";
export {
	composeClick,
	composeDrag,
	type MouseButton,
	type Point,
	type PointerEventStep,
} from "./pointer.ts";
export {
	composeLongPress,
	composePinch,
	composeSwipe,
	composeTap,
	LONG_PRESS_MS,
	type TouchStep,
} from "./touch.ts";
