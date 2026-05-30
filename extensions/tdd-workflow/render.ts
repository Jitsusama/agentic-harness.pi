/**
 * The scoreboard's two rendered surfaces: a compact status-line
 * indicator with a constant TDD label, and a wider widget line
 * that carries the phase, the iteration and the behaviour under
 * test. Both read the
 * loop's glyph and colour from the pure glyph vocabulary and
 * paint with the live theme. They produce strings only; lifecycle
 * owns the actual setStatus and setWidget calls. Neither renders
 * while the loop is idle: the scoreboard is silent between loops.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { glyph, visualState } from "./glyphs.js";
import type { LoopState } from "./machine.js";

/** Columns reserved for the glyph and the space that follows it. */
const GLYPH_COLS = 2;

/** The constant status-line label while a loop runs. */
const STATUS_LABEL = "TDD";

/**
 * The status-line indicator: the phase glyph and a constant TDD
 * label, or nothing at idle. The label stays put so the line
 * doesn't shift from step to step; the glyph carries the phase
 * through its shape and colour. The per-step detail lives in the
 * widget.
 */
export function renderStatus(
	state: LoopState,
	theme: Theme,
): string | undefined {
	if (state.phase === "idle") {
		return undefined;
	}
	const { char, token } = glyph(visualState(state));
	return `${theme.fg(token, char)} ${theme.fg("muted", STATUS_LABEL)}`;
}

/**
 * The widget line: the glyph, the iteration and phase, and the
 * behaviour under test, truncated to the available width.
 */
export function renderWidget(
	state: LoopState,
	theme: Theme,
	width: number,
): string[] {
	const { char, token } = glyph(visualState(state));
	const colouredGlyph = theme.fg(token, char);
	const label = `${state.phase} \u00b7${state.iteration}`;
	const prefix = `${colouredGlyph} ${theme.fg("muted", label)}`;
	if (!state.behaviour) {
		return [prefix];
	}
	const room = Math.max(0, width - GLYPH_COLS - (label.length + 1));
	const behaviour = truncateToWidth(state.behaviour, room);
	return [`${prefix} ${theme.fg("dim", behaviour)}`];
}
