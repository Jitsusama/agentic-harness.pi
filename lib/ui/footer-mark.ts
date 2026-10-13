/**
 * How an extension says something on the shared footer.
 *
 * The footer is one line that every extension writes into, and it
 * never shortens what an extension gives it: the line degrades its own
 * pieces, and an extension's status goes in whole or the whole line
 * falls back to a directory name. So each status costs exactly the
 * columns it asks for, and a status written as words ("guards:
 * commit-verification report") took most of the line.
 *
 * A status here is a mark: one glyph, in the colour of how much it
 * wants the person, and a quiet count only once there is more than one
 * of the thing. It is there only while it is true, and its detail is
 * one step away in the command that owns it. Text never carries the
 * colour; the glyph does.
 *
 * The marks live in one table, so a glance tells the person what is
 * talking and the same idea never wears two faces. Every glyph is in
 * the monospace fonts the harness targets, and none draws double
 * width.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** The footer's marks, and the only place these are spelled. */
export const FOOTER_GLYPH = {
	// A guard moved from where configuration put it, for this session.
	overridden: "\u2691",
	// The person is away and the session is working on alone.
	away: "\u263e",
	// Work running on after the turn that started it.
	background: "\u29d7",
	// A check failed. The same cross, under the same name, that review
	// and the spawned-agent marks use for a failed anything.
	failed: "\u2715",
	// The session runs a tree in place of the install pi's settings name.
	swapped: "\u21c4",
} as const;

/** What a footer mark is called. */
export type FooterMarkName = keyof typeof FOOTER_GLYPH;

/** Enough of a theme to colour a mark. */
export interface MarkTheme {
	fg(colour: ThemeColor, text: string): string;
}

/**
 * A footer mark: the glyph in its colour, then `count` dimmed when it
 * is more than one. `count` is omitted for a state that has no number.
 */
export function footerMark(
	name: FooterMarkName,
	colour: ThemeColor,
	theme: MarkTheme,
	count?: number,
): string {
	const mark = theme.fg(colour, FOOTER_GLYPH[name]);
	return count !== undefined && count > 1
		? `${mark} ${theme.fg("dim", String(count))}`
		: mark;
}
