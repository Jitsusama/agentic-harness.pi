/**
 * Whether an action can land, and what is stopping it.
 *
 * A click on an element that is not ready does nothing, and
 * says nothing, which is the worst failure a driver has: the
 * caller believes the page was acted on. Judging readiness
 * first turns that silence into a sentence.
 */

import type { Rect } from "./box.js";
import type { VisibilityVerdict } from "./visibility.js";

/** What is known about an element's readiness. */
export interface ActionabilityFacts {
	readonly present: boolean;
	readonly visibility?: VisibilityVerdict;
	readonly enabled: boolean;
	/** Whether it has stopped moving since the last look. */
	readonly settled: boolean;
}

/** Ready, or the one condition in the way. */
export interface Actionability {
	readonly ready: boolean;
	readonly blocker?: string;
}

/**
 * Judge whether an element can be acted on.
 *
 * The order matters for the same reason it does in the
 * visibility verdict: several conditions can hold at once, and
 * naming a shallow one sends someone looking at the wrong
 * thing. A missing element is not usefully also disabled.
 */
export function judgeActionability(facts: ActionabilityFacts): Actionability {
	if (!facts.present) {
		return { ready: false, blocker: "it is not in the page" };
	}
	if (facts.visibility && facts.visibility.state !== "visible") {
		// The verdict already explains itself. A second wording of
		// the same fact is a second thing to keep in agreement.
		return { ready: false, blocker: facts.visibility.because };
	}
	if (!facts.enabled) return { ready: false, blocker: "it is disabled" };
	if (!facts.settled) return { ready: false, blocker: "it is still moving" };
	return { ready: true };
}

/**
 * How far a box may drift and still count as still.
 *
 * Layout jitter below a pixel is not movement, and treating it
 * as such would leave an element never settling.
 */
const WOBBLE = 0.5;

/** Whether a box is where it was. */
export function sameBox(
	before: Rect | undefined,
	after: Rect | undefined,
	tolerance = WOBBLE,
): boolean {
	// Appearing or vanishing is the largest movement there is.
	if (!before || !after) return false;
	return (
		Math.abs(before.x - after.x) <= tolerance &&
		Math.abs(before.y - after.y) <= tolerance &&
		Math.abs(before.width - after.width) <= tolerance &&
		Math.abs(before.height - after.height) <= tolerance
	);
}
