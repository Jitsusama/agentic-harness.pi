/**
 * The text under a click on pi's screen, as plain text, with a word
 * that was broken across rows put back together.
 *
 * pi draws its screen as rows of styled text, so a click lands on a
 * cell, not on a word. This reads the row's plain text, counting each
 * character's cells as pi-tui does, and finds which character the
 * cell holds.
 *
 * A URL or path too long for its row is broken by pi-tui's wrapping,
 * which always starts a broken word on a fresh row and fills each row
 * with it to the edge, carrying on at the same column of the next. A
 * click on any piece is read as the whole word when its rows look like
 * that: each piece but the last starts its row's text and runs to its
 * end, and the next row carries on in the same column. Whether it also
 * reached the screen's right edge is said too, since that is what tells
 * a broken word from two that only happen to line up.
 */

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** The text a click landed in and which character of it is under the click. */
export interface ClickedText {
	text: string;
	index: number;
	/**
	 * How the text was put together: `row` is the clicked row alone;
	 * `edge` joins rows that each ran to the screen's right edge, as a
	 * broken word does; `column` joins rows that line up the same way
	 * but stop short of the edge, as a narrow column's do and as two
	 * words one to a row can.
	 */
	joined: "row" | "edge" | "column";
}

/** How many cells short of the right edge a full row may stop: padding, a border and a scrollbar. */
const EDGE_SLACK = 3;

/** How far a broken word is followed up and down, in rows. */
const MOST_ROWS = 12;

/** How many cells pi-tui counts a tab as. */
const TAB_CELLS = 3;

/** A scheme that starts a URL of its own, which no broken word continues with. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A list's marker before an item's text, which continuation rows indent past. */
const LIST_MARKER = /^(?:[-*+•]|\d+[.)])\s+/;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One character as it sits on a row: its offsets in the text and its first cell. */
interface Cell {
	start: number;
	end: number;
	column: number;
	width: number;
}

/** A screen row read as plain text, with where its text and its first word start. */
interface Row {
	text: string;
	cells: Cell[];
	/** Where the row's text starts, past any border, indent or list marker. */
	lead: number;
	leadColumn: number;
	marker: boolean;
	/** Where the first word after `lead` ends. */
	firstEnd: number;
	/** Where the row's last visible character ends, and the cell after it. */
	end: number;
	endColumn: number;
}

/**
 * The texts a click at cell (`x`, `y`) may be read in, the likeliest
 * first: the word broken across rows when the click is in one, then
 * the clicked row alone. Nothing when the cell is blank.
 */
export function textsAtClick(
	screen: readonly string[],
	x: number,
	y: number,
	columns: number,
): ClickedText[] {
	const rows = new Map<number, Row>();
	const rowAt = (at: number): Row | undefined => {
		if (at < 0 || at >= screen.length) return undefined;
		let row = rows.get(at);
		if (!row) {
			row = readRow(screen[at] ?? "");
			rows.set(at, row);
		}
		return row;
	};
	const clicked = rowAt(y);
	const index = clicked ? indexAtColumn(clicked, x) : undefined;
	if (!clicked || index === undefined || isGutter(clicked.text[index] ?? " "))
		return [];
	const alone: ClickedText = { text: clicked.text, index, joined: "row" };
	if (index < clicked.lead || index >= clicked.firstEnd) return [alone];

	// Every row of a broken word but its last is full, so each ends in
	// the same column, give or take a wide character that didn't fit.
	let full: number | undefined;
	const isFull = (row: Row): boolean => {
		full ??= row.endColumn;
		return Math.abs(row.endColumn - full) <= 1;
	};
	let edge = true;
	let bottom = y;
	while (bottom - y < MOST_ROWS) {
		const here = rowAt(bottom);
		const below = rowAt(bottom + 1);
		if (!here || !below || !continues(here, below) || !isFull(here)) break;
		edge &&= reachesEdge(here, columns);
		bottom++;
	}
	let top = y;
	while (y - top < MOST_ROWS) {
		const above = rowAt(top - 1);
		const here = rowAt(top);
		if (!above || !here || !continues(above, here) || !isFull(above)) break;
		edge &&= reachesEdge(above, columns);
		top--;
	}
	if (top === bottom) return [alone];

	let text = "";
	let clickedAt = 0;
	for (let at = top; at <= bottom; at++) {
		const row = rowAt(at);
		if (!row) break;
		const from = at === top ? 0 : row.lead;
		const to = at === bottom ? row.end : row.firstEnd;
		if (at === y) clickedAt = text.length + index - from;
		text += row.text.slice(from, to);
	}
	return [{ text, index: clickedAt, joined: edge ? "edge" : "column" }, alone];
}

/**
 * Whether `below` carries on the word `above` ends with: `above` holds
 * one word from its text's start to its end, and `below`'s text starts
 * in the same column with no list marker and no scheme of its own.
 */
function continues(above: Row, below: Row): boolean {
	return (
		above.firstEnd === above.end &&
		above.lead < above.end &&
		!below.marker &&
		below.leadColumn === above.leadColumn &&
		below.lead < below.firstEnd &&
		!SCHEME.test(below.text.slice(below.lead, below.firstEnd))
	);
}

function reachesEdge(row: Row, columns: number): boolean {
	return row.endColumn >= columns - EDGE_SLACK;
}

function readRow(line: string): Row {
	const text = stripTerminalSequences(line);
	const cells: Cell[] = [];
	let column = 0;
	for (const { segment, index } of segmenter.segment(text)) {
		const width = segment === "\t" ? TAB_CELLS : visibleWidth(segment);
		cells.push({ start: index, end: index + segment.length, column, width });
		column += width;
	}
	let lead = 0;
	while (lead < text.length && isGutter(text[lead] ?? "")) lead++;
	const marker = LIST_MARKER.exec(text.slice(lead));
	if (marker) lead += marker[0].length;
	let firstEnd = lead;
	while (firstEnd < text.length && !isGutter(text[firstEnd] ?? " ")) firstEnd++;
	let end = text.length;
	while (end > 0 && isGutter(text[end - 1] ?? " ")) end--;
	return {
		text,
		cells,
		lead,
		leadColumn: columnAt(cells, lead),
		marker: marker !== null,
		firstEnd,
		end,
		endColumn: columnAt(cells, end),
	};
}

/** The cell a text offset starts at, or the cell after the text for its end. */
function columnAt(cells: readonly Cell[], offset: number): number {
	for (const cell of cells) if (cell.start >= offset) return cell.column;
	const last = cells.at(-1);
	return last ? last.column + last.width : 0;
}

/** The text offset of the character covering cell `column`. */
function indexAtColumn(row: Row, column: number): number | undefined {
	for (const cell of row.cells) {
		if (column >= cell.column && column < cell.column + cell.width)
			return cell.start;
	}
	return undefined;
}

/** Whether a character is a space, or one of the box and block characters pi draws borders with. */
function isGutter(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return /\s/.test(character) || (code >= 0x2500 && code <= 0x259f);
}
