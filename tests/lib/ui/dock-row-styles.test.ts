/**
 * A docked row cut to the terminal's width leaves no styling open behind
 * it (ledger L8).
 *
 * Every row a docked widget hands pi goes through the dock's `clean`.
 * Cutting a row by string length once stopped inside a colour escape, or
 * after the escape that opened a colour but before the one that closed
 * it, and the colour ran on across every row pi drew after it. The cut
 * is by columns now and closes what it opened; these hold it there.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { clean } from "../../../lib/ui/dock.ts";

const ESC = String.fromCharCode(27);

/** Any SGR sequence, as a terminal reads one. */
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

/**
 * Whether a foreground colour or bold is still switched on at the end of
 * `line`, read the way a terminal applies the sequences in order.
 */
function leftOpen(line: string): boolean {
	let open = false;
	for (const match of line.matchAll(SGR)) {
		const codes = (match[1] ?? "").split(";").filter(Boolean);
		if (codes.length === 0 || codes.includes("0")) open = false;
		else if (codes.some((code) => code === "39" || code === "22")) open = false;
		else open = true;
	}
	return open;
}

/**
 * An escape that was started and never finished, wherever it is: a reset
 * appended after a torn one does not mend it, since the terminal reads the
 * reset as the rest of the torn sequence.
 */
const TORN = new RegExp(`${ESC}(?!\\[[0-9;]*[A-Za-z])`);

const WIDTH = 20;

describe("a styled row wider than the terminal", () => {
	it("is cut to the width in columns, not in characters", () => {
		const row = `${ESC}[31m${"x".repeat(60)}${ESC}[39m`;
		expect(visibleWidth(clean(row, WIDTH))).toBeLessThanOrEqual(WIDTH);
	});

	it("does not leave its colour switched on after the cut", () => {
		const row = `${ESC}[31m${"x".repeat(60)}${ESC}[39m after`;
		expect(leftOpen(clean(row, WIDTH))).toBe(false);
	});

	it("is never cut through the middle of an escape", () => {
		// Place a long escape so that a cut by string length lands inside it.
		for (let lead = 0; lead < WIDTH + 4; lead++) {
			const row = `${"a".repeat(lead)}${ESC}[1;38;5;208m${"b".repeat(40)}${ESC}[0m`;
			const cut = clean(row, WIDTH);
			expect(cut, `lead ${lead}`).not.toMatch(TORN);
			expect(leftOpen(cut), `lead ${lead}`).toBe(false);
		}
	});
});
