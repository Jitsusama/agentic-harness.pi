/**
 * Gestures, composed from touch points.
 *
 * A tap is not a click. A page that handles touchstart, or that
 * distinguishes a swipe from a scroll, cannot be exercised with
 * a mouse at all, and on a phone layout those handlers are
 * usually the only way to reach half the interface.
 *
 * Pinch is the reason these are sequences rather than events: it
 * needs two points moving relative to each other, which no
 * single event can express.
 */

import { interpolate, type Point, ratios } from "./pointer.js";

/** One finger, at a moment. */
export interface TouchPoint {
	readonly x: number;
	readonly y: number;
	/** Which finger this is, stable across the gesture. */
	readonly id: number;
}

/** One touch event, ready to dispatch. */
export interface TouchStep {
	readonly type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
	readonly points: readonly TouchPoint[];
	/** How long to wait after dispatching, when it matters. */
	readonly pauseMs?: number;
}

/** How many moves a swipe makes by default. */
const DEFAULT_SWIPE_STEPS = 10;

/** How many moves a pinch makes by default. */
const DEFAULT_PINCH_STEPS = 10;

/**
 * How long a press has to last to count as long.
 *
 * Chrome's own gesture recognizer uses half a second, and a
 * context menu that opens on long press is watching for roughly
 * that, so a shorter hold is just a tap.
 */
export const LONG_PRESS_MS = 500;

/** A tap: one finger down, one finger up. */
export function composeTap(at: Point): readonly TouchStep[] {
	return [
		{ type: "touchStart", points: [{ ...at, id: 0 }] },
		{ type: "touchEnd", points: [] },
	];
}

/**
 * A long press: the same as a tap, held.
 *
 * The end carries no points because a touch that has lifted is
 * not at a position any more, which is the protocol's rule and
 * a sensible one.
 */
export function composeLongPress(
	at: Point,
	holdMs: number = LONG_PRESS_MS,
): readonly TouchStep[] {
	return [
		{ type: "touchStart", points: [{ ...at, id: 0 }], pauseMs: holdMs },
		{ type: "touchEnd", points: [] },
	];
}

/** A swipe: down, travel, up. */
export function composeSwipe(
	from: Point,
	to: Point,
	options: { steps?: number } = {},
): readonly TouchStep[] {
	const steps = options.steps ?? DEFAULT_SWIPE_STEPS;
	return [
		{ type: "touchStart", points: [{ ...from, id: 0 }] },
		...interpolate(from, to, steps).map(
			(point): TouchStep => ({
				type: "touchMove",
				points: [{ ...point, id: 0 }],
			}),
		),
		{ type: "touchEnd", points: [] },
	];
}

/**
 * A pinch: two fingers either side of a centre, moving together
 * or apart.
 *
 * The spread is the distance between the fingers, so a spread
 * that grows is a zoom in and one that shrinks is a zoom out.
 * Expressing it that way means the caller never has to work out
 * where two fingers should individually go.
 */
export function composePinch(
	centre: Point,
	from: number,
	to: number,
	options: { steps?: number } = {},
): readonly TouchStep[] {
	const steps = options.steps ?? DEFAULT_PINCH_STEPS;
	const fingers = (spread: number): readonly TouchPoint[] => [
		{ x: centre.x - spread / 2, y: centre.y, id: 0 },
		{ x: centre.x + spread / 2, y: centre.y, id: 1 },
	];

	return [
		{ type: "touchStart", points: fingers(from) },
		...ratios(steps)
			.map((ratio) => from + (to - from) * ratio)
			.map(
				(spread): TouchStep => ({
					type: "touchMove",
					points: fingers(spread),
				}),
			),
		{ type: "touchEnd", points: [] },
	];
}
