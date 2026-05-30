/**
 * The scoreboard's two rendered surfaces: a compact status-line
 * indicator and a wider widget line that names the behaviour
 * under test. Both read the loop's glyph and colour from the
 * pure glyph vocabulary and paint with the live theme. They
 * produce strings only; lifecycle owns the actual setStatus and
 * setWidget calls.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { glyph, visualState } from "./glyphs.js";
import type { LoopState } from "./machine.js";

/** Columns reserved for the glyph and the space that follows it. */
const GLYPH_COLS = 2;

/** The status-line indicator, or nothing until a loop is engaged. */
export function renderStatus(
	state: LoopState,
	theme: Theme,
): string | undefined {
	if (!state.engaged) {
		return undefined;
	}
	const { char, token } = glyph(visualState(state));
	return `${theme.fg(token, char)} ${theme.fg("muted", "TDD")}`;
}

/** The widget line: the loop glyph and the behaviour under test. */
export function renderWidget(
	state: LoopState,
	theme: Theme,
	width: number,
): string[] {
	const { char, token } = glyph(visualState(state));
	const colouredGlyph = theme.fg(token, char);
	if (!state.behaviour) {
		return [colouredGlyph];
	}
	const room = Math.max(0, width - GLYPH_COLS);
	const behaviour = truncateToWidth(state.behaviour, room);
	return [`${colouredGlyph} ${theme.fg("dim", behaviour)}`];
}
