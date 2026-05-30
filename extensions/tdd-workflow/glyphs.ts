/**
 * The visual vocabulary of the scoreboard: one glyph per state
 * of the loop. The circle fills monotonically as the test
 * materializes (empty, quarter, half, full), so every build-up
 * state is a distinct shape and the progression reads without
 * colour. At green the shape turns to a check and at refactor to
 * a diamond: these two deliberately leave the circle family
 * because they are a different kind of activity, not another
 * notch of the same build-up. Fill encodes progress, colour
 * reinforces meaning, and shape alone keeps the states apart.
 */

import type { LoopState } from "./machine.js";

/** The seven distinct states the scoreboard can show. */
export type VisualState =
	| "idle"
	| "plan"
	| "write"
	| "red-unverified"
	| "red-verified"
	| "green"
	| "refactor";

/** Collapse a loop's phase and assertion verification into one visual state. */
export function visualState(state: LoopState): VisualState {
	if (state.phase === "red") {
		return state.assertionFailure ? "red-verified" : "red-unverified";
	}
	return state.phase;
}

/**
 * The theme tokens the scoreboard paints with. A narrow subset
 * of pi's palette: yellow for authoring, red for failing, green
 * for passing, blue for refactoring and dim for idle.
 */
export type GlyphToken = "dim" | "warning" | "error" | "success" | "accent";

/** A glyph and the colour it should be painted in. */
export interface Glyph {
	char: string;
	token: GlyphToken;
}

const GLYPHS: Record<VisualState, Glyph> = {
	idle: { char: "\u25cc", token: "dim" },
	plan: { char: "\u25cb", token: "warning" },
	write: { char: "\u25d4", token: "warning" },
	"red-unverified": { char: "\u25d1", token: "error" },
	"red-verified": { char: "\u25cf", token: "error" },
	green: { char: "\u2713", token: "success" },
	refactor: { char: "\u25c6", token: "accent" },
};

/** The glyph and colour for a visual state. */
export function glyph(state: VisualState): Glyph {
	return GLYPHS[state];
}
