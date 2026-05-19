/**
 * Narration lines: single-line transcript annotations for
 * side-effect actions, surface coordination and ambient
 * status. The pattern is `※ <prefix>: <body>` rendered in
 * dim text so it doesn't compete with the main conversation.
 *
 * Used by extensions that need to surface mutations or
 * cross-surface actions in the transcript without producing
 * a full message or opening a panel. Example uses:
 *
 *   ※ nvim: opened state.ts at line 160
 *   ※ pr-workflow: endorsed finding 3
 *   ※ tdd-workflow: tests green (12 pass, 0 fail)
 *
 * The glyph and dim styling give the user a consistent
 * visual cue that this line is automation narration, not
 * agent prose or user input.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";

/** Glyph that prefixes every narration line. */
export const NARRATION_GLYPH = "※";

/** Severity level for narration. Affects accent only; never blocks. */
export type NarrationLevel = "info" | "warn" | "error";

/** Options for rendering a narration line. */
export interface NarrationOptions {
	/** Visual emphasis. Defaults to `"info"` (fully dim). */
	level?: NarrationLevel;
	/** Suppress the leading glyph. Defaults to false. */
	noGlyph?: boolean;
}

/**
 * Render a single-line narration string.
 *
 * The prefix is rendered with mild accent so it reads as a
 * source identifier; the body is dim so it stays out of the
 * way. Returns a single themed string (no trailing newline).
 *
 * The caller decides where the line lands (transcript via
 * `pi.sendMessage`, status fragment, log file, etc.).
 */
export function renderNarrationLine(
	prefix: string,
	body: string,
	theme: Theme,
	options?: NarrationOptions,
): string {
	const level = options?.level ?? "info";
	const accentColor =
		level === "error" ? "error" : level === "warn" ? "warning" : "muted";

	const parts: string[] = [];
	if (!options?.noGlyph) parts.push(theme.fg("dim", NARRATION_GLYPH));
	parts.push(theme.fg(accentColor, `${prefix}:`));
	parts.push(theme.fg("dim", body));
	return parts.join(" ");
}
