/**
 * What an answered gate leaves in the transcript.
 *
 * A docked gate that simply left would take its rows with it, and pi does
 * not scroll back up: the rows it stood in stay blank under the editor
 * until something grows into them. So a gate answered by its person, or
 * closed by its turn, settles into the transcript as its own record in the
 * frame it leaves: its content as shown, the verdict where its key hints
 * stood, the same height it stood at, so no row on the screen moves.
 *
 * It then gives rows back exactly as lines arrive below it, the result
 * card, the next message, a widget that grows, so its top stays on the
 * same screen row and nothing above it ever changes, which is what keeps
 * pi from replaying the whole transcript. It gives them back only while it
 * is on screen, this frame and the last: a row that changes above the
 * viewport costs a full redraw, so a record pushed off the top freezes at
 * the height it had. Either way it ends as the rows it kept, in scrollback.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { clean } from "./dock.ts";
import {
	dockRows,
	markSettling,
	rowsAfter,
	settleIntoChat,
} from "./pi-layout.ts";

/**
 * Puts `lines`, the gate as it stood with its verdict in place, into the
 * transcript, and `one`, what it says once it has given back all but one
 * row. `under` is how many rows stood below the gate in the frame
 * last painted (see `rowsUnderGate`), the measure its growth is taken
 * against: everything below that can grow, the transcript after the
 * record and the dock, so a widget the gate squeezed takes its rows back
 * from the record rather than pushing it off the top. False when the
 * transcript could not be read and nothing was put.
 */
export function settleRecord(
	tui: TUI,
	lines: readonly string[],
	one: string,
	under: number,
): boolean {
	const tall = lines.length;
	const base = under;
	let keep = tall;
	let frozen = false;
	// Rows from the record's top to the screen's bottom, last frame.
	let lastSpan = 0;

	// What it drew last, by the width and height it drew at, since a
	// settled record draws the same rows at the same width every frame.
	let drawn: { at: number; keep: number; rows: string[] } | undefined;
	const shown = (at: number): string[] => {
		if (drawn?.at === at && drawn.keep === keep) return drawn.rows;
		const rows = (keep === 1 ? [one] : lines.slice(tall - keep)).map((line) =>
			clean(line, at),
		);
		drawn = { at, keep, rows };
		return rows;
	};

	const record: Component = {
		render(at) {
			// Settled for good: nothing below it can change what it shows, so
			// it measures nothing. A record stays in the transcript for the
			// rest of the session, and one that measured every frame would
			// draw the transcript below it and the dock again, every frame,
			// for every gate ever answered.
			if (frozen || keep <= 1) return shown(at);
			const after = rowsAfter(tui, record, at);
			const dock = dockRows(tui, at);
			const want = Math.max(1, tall - Math.max(0, after + dock - base));
			const rows = tui.terminal.rows;
			const onScreen = want + after + dock <= rows && lastSpan <= rows;
			if (want < keep && onScreen) keep = want;
			else if (want < keep) frozen = true;
			if (!frozen && keep > 1) lastSpan = keep + after + dock;
			return shown(at);
		},
		invalidate() {},
	};
	markSettling(
		record,
		() => !frozen && keep > 1,
		() => Math.min(keep, tall),
	);

	if (!settleIntoChat(tui, record)) return false;
	tui.requestRender();
	return true;
}
