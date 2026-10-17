/**
 * How every panel draws its frame: the edges, the title and the keys.
 *
 * The accent is kept for keys, so that wherever it shows on a panel it
 * means "press this". The frame used to be drawn in it too, edges and
 * title alike, which put three green things on every panel and only one
 * of them was something to press. One home for these, so a panel cannot
 * drift from the rest by drawing its own.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { GLYPH } from "./types.ts";

/** A panel's top or bottom edge: a hairline in the rule colour. */
export function frameRule(theme: Theme, width: number): string {
	return theme.fg("border", GLYPH.hrule.repeat(Math.max(0, width)));
}

/**
 * A panel's title, bold in the strongest text: the first thing read, and
 * so the heaviest ink on the panel rather than the most colourful.
 */
export function frameTitle(theme: Theme, title: string): string {
	return theme.fg("toolTitle", theme.bold(title));
}

/**
 * A key and what it does, as every hint on a panel draws one: the key in
 * the accent, since it is the thing to press, and its word quieter after
 * it. A key named without a word says nothing about why to press it.
 */
export function chord(theme: Theme, key: string, word: string): string {
	return `${theme.fg("accent", key)} ${theme.fg("dim", word)}`;
}
