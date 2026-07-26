/**
 * Whether a person could actually see and click this.
 *
 * "Is it there" has several answers that look alike from the
 * outside and need entirely different fixes: not rendered at
 * all, rendered with no size, rendered off screen, rendered
 * under something else, rendered invisibly. A caller whose
 * click went nowhere needs to be told which.
 */

import type { Rect } from "./box.js";

/** What a person would find when they looked. */
export type Visible =
	| "visible"
	| "not rendered"
	| "zero size"
	| "off screen"
	| "covered"
	| "transparent";

/** The area a person can currently see. */
export interface Viewport {
	readonly width: number;
	readonly height: number;
}

/** What is known about an element's presence. */
export interface VisibilityFacts {
	/** Whether the capture could measure a box at all. */
	readonly rendered: boolean;
	readonly border?: Rect;
	readonly viewport?: Viewport;
	/** What the hit test found instead, described for a person. */
	readonly coveredBy?: string;
	readonly opacity?: number;
	readonly visibility?: string;
}

/** One plain answer, with the reason it was reached. */
export interface VisibilityVerdict {
	readonly state: Visible;
	readonly because: string;
}

/**
 * Judge an element's presence.
 *
 * The order matters. An element that is not rendered cannot
 * usefully also be called covered, and saying so would send
 * someone hunting an overlay that is not the cause. So the most
 * fundamental problem is the one reported.
 */
export function judgeVisibility(facts: VisibilityFacts): VisibilityVerdict {
	if (!facts.rendered || !facts.border) {
		return {
			state: "not rendered",
			because: "it has no box, so display is none or it is not in the page",
		};
	}
	if (facts.visibility === "hidden" || facts.visibility === "collapse") {
		return {
			state: "not rendered",
			because: `its visibility is ${facts.visibility}`,
		};
	}

	const { width, height } = facts.border;
	if (width === 0 || height === 0) {
		return { state: "zero size", because: `it measures ${width} by ${height}` };
	}

	if (facts.opacity === 0) {
		return { state: "transparent", because: "its opacity is 0" };
	}

	const viewport = facts.viewport;
	if (viewport && !overlaps(facts.border, viewport)) {
		return {
			state: "off screen",
			because:
				`it sits outside the ${viewport.width} by ${viewport.height} ` +
				"viewport and needs scrolling to",
		};
	}

	if (facts.coveredBy) {
		return {
			state: "covered",
			because: `${facts.coveredBy} is painted over its centre`,
		};
	}

	return {
		state: "visible",
		because: "it is on screen and receives its own centre",
	};
}

/**
 * Whether any part of the box is on screen. Half a control is
 * still usable, and calling it off screen would send a caller
 * scrolling for no reason.
 */
function overlaps(border: Rect, viewport: Viewport): boolean {
	return (
		border.x < viewport.width &&
		border.y < viewport.height &&
		border.x + border.width > 0 &&
		border.y + border.height > 0
	);
}
