/**
 * A panel is drawn over the transcript, not below it, so every row it emits
 * has to cover the row underneath.
 *
 * This was found from a screenshot rather than from a test. A propose gate
 * opened straight after a long refusal, and the refusal's text appeared
 * between the gate's own lines: the body rows were padded to the width by the
 * markdown renderer and so looked clean, while the header rows, the blank
 * separators and the consequence line were short and let the transcript show
 * through. It reads as the panel being interleaved with other output, which
 * is exactly what it is.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { opaqueRow } from "../../../lib/ui/panel-layout.js";

const WIDTH = 40;

describe("making a panel row opaque", () => {
	it("pads a short row out to the full width", () => {
		expect(opaqueRow("a short row", WIDTH)).toHaveLength(WIDTH);
	});

	it("pads an empty row, which is the one that bled the most", () => {
		// A blank separator carried no characters at all, so every column of
		// the row beneath it stayed visible.
		expect(opaqueRow("", WIDTH)).toBe(" ".repeat(WIDTH));
	});

	it("measures columns rather than characters, so a styled row still covers", () => {
		// Escape codes occupy no columns. Padding by string length would stop
		// short by exactly the length of the styling.
		const styled = `\u001b[31mred\u001b[0m`;

		expect(visibleWidth(opaqueRow(styled, WIDTH))).toBe(WIDTH);
	});

	it("leaves a row that already fills the width alone", () => {
		const full = "x".repeat(WIDTH);

		expect(opaqueRow(full, WIDTH)).toBe(full);
	});

	it("truncates a row that overruns, as it did before", () => {
		expect(visibleWidth(opaqueRow("y".repeat(WIDTH + 20), WIDTH))).toBe(WIDTH);
	});
});
