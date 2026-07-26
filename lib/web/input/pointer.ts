/**
 * Mouse movement as a sequence, not a teleport.
 *
 * A click can be delivered at a point, but a drag cannot: an
 * element that follows the pointer needs to see it move, and a
 * hover menu that opens on entry needs the pointer to arrive
 * rather than appear. So a gesture is composed as the ordered
 * events a real hand would produce, and the composition is pure
 * so it can be checked without a browser.
 */

/** A point in viewport coordinates. */
export interface Point {
	readonly x: number;
	readonly y: number;
}

/** Which button an event carries. */
export type MouseButton = "left" | "middle" | "right" | "back" | "forward";

/** One mouse event, ready to dispatch. */
export interface PointerEventStep {
	readonly type: "mouseMoved" | "mousePressed" | "mouseReleased";
	readonly x: number;
	readonly y: number;
	readonly button: MouseButton | "none";
	readonly clickCount: number;
}

/** How a drag is drawn between two points. */
export interface DragOptions {
	/** How many intermediate moves to make on the way. */
	readonly steps?: number;
	readonly button?: MouseButton;
}

/**
 * How many moves a drag makes by default.
 *
 * One move is a teleport and anything watching mousemove sees a
 * single jump. Enough intermediate points that a drag handler
 * runs several times is the difference between exercising the
 * interaction and merely landing on its endpoint.
 */
const DEFAULT_DRAG_STEPS = 10;

/**
 * How far along the way each step is, ending exactly at one.
 *
 * Everything that travels shares this: a pointer crossing the
 * screen and two fingers changing their distance are the same
 * ramp applied to different quantities.
 *
 * Fewer than one step still has to arrive somewhere, and the
 * only defensible somewhere is the destination.
 */
export function ratios(steps: number): readonly number[] {
	if (steps < 1) return [1];
	return Array.from({ length: steps }, (_, index) => (index + 1) / steps);
}

/** Points along a straight line, ending exactly at the end. */
export function interpolate(
	from: Point,
	to: Point,
	steps: number,
): readonly Point[] {
	return ratios(steps).map((ratio) => ({
		x: from.x + (to.x - from.x) * ratio,
		y: from.y + (to.y - from.y) * ratio,
	}));
}

/**
 * A drag: arrive, press, travel, release.
 *
 * The move before the press matters. Dragging from wherever the
 * pointer happened to be left would press the wrong element.
 */
export function composeDrag(
	from: Point,
	to: Point,
	options: DragOptions = {},
): readonly PointerEventStep[] {
	const button = options.button ?? "left";
	const steps = options.steps ?? DEFAULT_DRAG_STEPS;

	return [
		{ type: "mouseMoved", ...from, button: "none", clickCount: 0 },
		{ type: "mousePressed", ...from, button, clickCount: 1 },
		...interpolate(from, to, steps).map(
			(point): PointerEventStep => ({
				type: "mouseMoved",
				...point,
				button,
				clickCount: 1,
			}),
		),
		{ type: "mouseReleased", ...to, button, clickCount: 1 },
	];
}

/** A click at a point, optionally repeated for double or triple. */
export function composeClick(
	at: Point,
	options: { button?: MouseButton; count?: number } = {},
): readonly PointerEventStep[] {
	const button = options.button ?? "left";
	const count = Math.max(1, options.count ?? 1);

	const steps: PointerEventStep[] = [
		{ type: "mouseMoved", ...at, button: "none", clickCount: 0 },
	];
	// A double click is two clicks whose count rises, not one
	// event with a count of two. Anything listening for dblclick
	// is watching that number climb.
	for (let click = 1; click <= count; click += 1) {
		steps.push(
			{ type: "mousePressed", ...at, button, clickCount: click },
			{ type: "mouseReleased", ...at, button, clickCount: click },
		);
	}
	return steps;
}
