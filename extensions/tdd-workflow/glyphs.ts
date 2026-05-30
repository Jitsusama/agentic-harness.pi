/**
 * The visual vocabulary of the scoreboard: one glyph per state
 * of the loop. The circle fills as the test materializes (open,
 * half, full), then transforms into a check when it passes and a
 * diamond while refactoring. Fill encodes progress, colour
 * encodes meaning and every state is a distinct shape, so the
 * scoreboard stays legible without colour.
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

/** Collapse a loop's phase and red verification into one visual state. */
export function visualState(state: LoopState): VisualState {
	if (state.phase === "red") {
		return state.redVerified ? "red-verified" : "red-unverified";
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
	write: { char: "\u25d0", token: "warning" },
	"red-unverified": { char: "\u25d0", token: "error" },
	"red-verified": { char: "\u25cf", token: "error" },
	green: { char: "\u2713", token: "success" },
	refactor: { char: "\u25c6", token: "accent" },
};

/** The glyph and colour for a visual state. */
export function glyph(state: VisualState): Glyph {
	return GLYPHS[state];
}
