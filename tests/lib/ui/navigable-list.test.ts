/**
 * The row under the cursor carries the accent, since it's where the keys
 * act, and nothing else in the list does.
 *
 * Drawn through a stand-in that colours as a terminal does, each colour
 * ended by the same reset, since that's how a glyph's colour once ended
 * an accent laid over the whole row: the fake theme's tags nest as text
 * and can't show it.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderNavigableList } from "../../../lib/ui/navigable-list.ts";

const CODES: Record<string, number> = { accent: 32, success: 33, dim: 90 };
const NAMES = Object.fromEntries(
	Object.entries(CODES).map(([name, code]) => [code, name]),
);

const ansi = {
	fg: (color: string, text: string) =>
		`\x1b[${CODES[color] ?? 37}m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** The colour a terminal would draw `needle` in, from the codes before it. */
function colourOf(line: string, needle: string): string {
	const before = line.slice(0, line.indexOf(needle));
	const codes = before
		.split("\x1b[")
		.slice(1)
		.map((part) => Number.parseInt(part, 10));
	const last = codes.at(-1);
	return last === undefined || last === 39 ? "plain" : NAMES[last];
}

describe("a navigable list", () => {
	const { lines } = renderNavigableList(
		[
			{
				glyph: ansi.fg("success", "◆"),
				summary: "chosen",
				subtitle: ["under it"],
			},
			{ summary: "other" },
		],
		0,
		ansi,
	);

	it("draws the selected row's cursor and text in the accent, past a coloured glyph", () => {
		expect(colourOf(lines[0], "▸")).toBe("accent");
		expect(colourOf(lines[0], "◆")).toBe("success");
		expect(colourOf(lines[0], "chosen")).toBe("accent");
	});

	it("keeps the accent off the selected row's subtitle", () => {
		expect(colourOf(lines[1], "under it")).toBe("dim");
		expect(lines[1]).not.toContain(`\x1b[${CODES.accent}m`);
	});

	it("draws the other rows plain", () => {
		expect(colourOf(lines[2], "other")).toBe("plain");
	});
});
