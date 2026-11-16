/**
 * The keyboard walk's shared fixtures. Every one mirrors a shape
 * taken from a real capture, including the detail that a computed
 * outline keeps its width even when its style is none.
 */

import type {
	FocusStyle,
	WalkCandidate,
	WalkCapture,
	WalkStop,
} from "../../../../lib/core/web/a11y/walk.ts";

/** What Chrome reports for an element with no outline at all. */
export const AT_REST: FocusStyle = {
	outlineStyle: "none",
	outlineWidth: "3px",
	outlineColor: "rgb(0, 0, 0)",
	boxShadow: "none",
	backgroundColor: "rgba(0, 0, 0, 0)",
	borderColor: "rgb(118, 118, 118)",
	color: "rgb(0, 0, 0)",
};

export const RINGED: FocusStyle = {
	...AT_REST,
	outlineStyle: "solid",
	outlineColor: "rgb(0, 102, 204)",
};

/** A control the walk could reach, resting with no ring. */
export const candidate = (
	index: number,
	name: string,
	over: Partial<WalkCandidate> = {},
): WalkCandidate => ({
	index,
	tag: "BUTTON",
	name,
	resting: AT_REST,
	...over,
});

/** Where one Tab press landed, ringed unless told otherwise. */
export const stop = (
	index: number,
	name: string,
	over: Partial<WalkStop> = {},
): WalkStop => ({
	index,
	tag: "BUTTON",
	name,
	inViewport: true,
	focused: RINGED,
	...over,
});

/** A walk with nothing in it but what a test adds. */
export const capture = (over: Partial<WalkCapture> = {}): WalkCapture => ({
	candidates: [],
	stops: [],
	unreachable: [],
	...over,
});
