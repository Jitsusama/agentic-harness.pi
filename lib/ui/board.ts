/**
 * A board: spawned work drawn as one titled row per participant, for a
 * widget docked above the editor.
 *
 * A fleet of subagents and a round of reviewers are the same thing seen
 * from two tools, so they share this shape while each keeps its own words
 * for a row. The shape is chosen for the dock rather than for a panel:
 *
 * - The title is a rule, so the board is set off from the transcript above
 *   it without spending a row on a frame. It carries the tally, and on the
 *   right either the chord that reaches the board or the last thing the
 *   board said.
 * - The keys the board answers get a row of their own only while it has
 *   focus, since until then none of them reach it.
 * - There is no bottom rule: the editor's own border is directly below.
 *
 * So a board is at most two rows taller than its participant and reason
 * rows, which is the relation a result card relies on to be at least as
 * tall as the board it replaces (a shorter card leaves blank rows behind).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DOCK_HOP_LABEL, type HopPlace, hopLabel } from "./dock.ts";

/** What a board shows, before it is fitted to a width or a height. */
export interface Board {
	/** The title and tally, styled, for the left of the rule. */
	readonly title: string;
	/** For the right of the rule: a notice, or how to reach the board. */
	readonly aside: string;
	/** The keys it answers, shown while it has focus. */
	readonly keys?: string;
	/** One row per participant, in roster order. */
	readonly rows: readonly string[];
	/** The row holding the selection, kept in view when rows are cut. */
	readonly selected: number;
	/** What does not fit on a row, such as a failure's reason. */
	readonly notes: readonly string[];
}

/**
 * How a board's title rule says to reach its keys, counted from wherever
 * the keyboard is: "Ctrl+Alt+N to manage", "Ctrl+Alt+N twice to manage".
 * Nothing while the board has them, since its keys row says what the
 * chord does from there.
 */
export function reachBoard(place: HopPlace | undefined): string {
	if (place?.presses === 0) return "";
	return `${hopLabel(place?.presses ?? 1)} to manage`;
}

/**
 * Where the chord goes from a board holding the keys, for its keys row:
 * on to the next widget the hop reaches, or back to the editor.
 */
export function hopOnward(place: HopPlace | undefined): string {
	const next = place?.next;
	return next === undefined
		? `${DOCK_HOP_LABEL} back to the editor`
		: `${DOCK_HOP_LABEL} to the ${next}`;
}

/** The rows beyond participants and notes a board can take: title and keys. */
export const BOARD_CHROME_ROWS = 2;

/** The title rule: `── title ────── aside ──`, filled to `width`. */
function titleRule(
	theme: Theme,
	width: number,
	title: string,
	aside: string,
): string {
	const left = `${theme.fg("accent", "──")} ${title} `;
	const right = aside === "" ? "" : ` ${aside} ${theme.fg("accent", "──")}`;
	const fill = width - visibleWidth(left) - visibleWidth(right);
	if (fill >= 1)
		return `${left}${theme.fg("accent", "─".repeat(fill))}${right}`;
	const bare = width - visibleWidth(left);
	if (bare >= 1) return `${left}${theme.fg("accent", "─".repeat(bare))}`;
	return truncateToWidth(left, width);
}

/** Every row of the board with all the room it wants. */
export function boardLines(
	board: Board,
	theme: Theme,
	width: number,
	focused: boolean,
): string[] {
	const lines = [titleRule(theme, width, board.title, board.aside)];
	if (focused && board.keys !== undefined) lines.push(` ${board.keys}`);
	return [...lines, ...board.rows, ...board.notes];
}

/**
 * The board in `height` rows, fewer than it wants.
 *
 * The title stays, since it says what the board is. Participant rows come
 * next, a window of them holding the selection, and the title counts the
 * ones cut. The keys row and the notes take what is left, in that order.
 */
export function fitBoard(
	board: Board,
	theme: Theme,
	width: number,
	focused: boolean,
	height: number,
): string[] {
	if (height <= 0) return [];
	const rows = board.rows;
	const room = height - 1;
	const shown = Math.min(rows.length, room);
	const hidden = rows.length - shown;
	const title =
		hidden === 0
			? board.title
			: `${board.title} ${theme.fg("dim", `· ${hidden} more`)}`;
	const lines = [titleRule(theme, width, title, board.aside)];
	let spare = room - shown;
	if (focused && board.keys !== undefined && spare > 0) {
		lines.push(` ${board.keys}`);
		spare--;
	}
	const selected = Math.max(0, Math.min(board.selected, rows.length - 1));
	const from = Math.max(
		0,
		Math.min(selected - Math.floor(shown / 2), rows.length - shown),
	);
	lines.push(...rows.slice(from, from + shown));
	lines.push(...board.notes.slice(0, spare));
	return lines;
}
