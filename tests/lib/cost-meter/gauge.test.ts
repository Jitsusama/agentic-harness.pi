import { describe, expect, it } from "vitest";
import {
	contextGauge,
	GAP,
	marginalText,
	medianOf,
	sessionText,
} from "../../../lib/internal/cost-meter/index.ts";

describe("contextGauge", () => {
	it("fills the glyph as the window fills", () => {
		expect(contextGauge(50_000, 1_000_000).glyph).toBe("\u25d4");
		expect(contextGauge(300_000, 1_000_000).glyph).toBe("\u25d1");
		expect(contextGauge(600_000, 1_000_000).glyph).toBe("\u25d5");
		expect(contextGauge(900_000, 1_000_000).glyph).toBe("\u25cf");
	});

	it("drops the denominator, which never changes within a session", () => {
		expect(contextGauge(412_000, 1_000_000).text).toBe("412k");
	});

	it("reads as a percentage when asked to be narrow", () => {
		expect(contextGauge(412_000, 1_000_000, true).text).toBe("41%");
	});

	it("names a colour token rather than colouring itself", () => {
		// The widget owns the theme. A helper that emits ANSI cannot be
		// tested for what it says, only for what it paints.
		expect(contextGauge(100_000, 1_000_000).token).toBe("dim");
		expect(contextGauge(700_000, 1_000_000).token).toBe("warning");
		expect(contextGauge(900_000, 1_000_000).token).toBe("error");
	});

	it("holds at empty when the window is unknown", () => {
		// Dividing by a window of zero must not paint a full gauge and
		// tell the reader they are about to be compacted.
		const gauge = contextGauge(412_000, 0);
		expect(gauge.glyph).toBe("\u25d4");
		expect(gauge.token).toBe("dim");
		expect(gauge.text).toBe("412k");
	});
});

describe("medianOf", () => {
	it("is unmoved by one cold-cache turn among warm ones", () => {
		// A turn after an idle gap costs about $3.50 against $0.24 warm.
		// A mean would let one of those repaint the whole reading.
		expect(medianOf([0.24, 0.22, 3.5, 0.25, 0.23])).toBeCloseTo(0.24, 5);
	});

	it("averages the middle pair when the count is even", () => {
		expect(medianOf([1, 2, 3, 4])).toBeCloseTo(2.5, 5);
	});

	it("has nothing to say about no turns", () => {
		expect(medianOf([])).toBeNull();
	});
});

describe("marginalText", () => {
	it("marks a rate with the partial, not a total's sigma", () => {
		expect(marginalText(0.42)).toBe("\u2202 $0.42");
	});

	it("keeps cents on a rate however small, since that is the signal", () => {
		expect(marginalText(0.09)).toBe("\u2202 $0.09");
	});

	it("says nothing until a session has turns to measure", () => {
		expect(marginalText(null)).toBeNull();
	});
});

describe("sessionText", () => {
	it("marks an accumulated total with a sigma", () => {
		expect(sessionText(4.213)).toBe("\u03a3 $4.21");
	});

	it("drops cents once the figure is large enough not to need them", () => {
		expect(sessionText(143.77)).toBe("\u03a3 $144");
	});

	it("says nothing before anything is spent", () => {
		expect(sessionText(0)).toBeNull();
	});
});

describe("spacing", () => {
	it("separates every marker from its value the same way", () => {
		// One gap, everywhere, no exceptions. A space that appears after
		// the gauge but not after the rate reads as an oversight, because
		// that is exactly what it was.
		const gauge = contextGauge(361_000, 1_000_000);
		const pieces = [
			`${gauge.glyph}${GAP}${gauge.text}`,
			marginalText(0.42),
			sessionText(4.21),
		];
		for (const piece of pieces) {
			expect(piece?.slice(1, 1 + GAP.length)).toBe(GAP);
		}
	});

	it("reads end to end with a single width throughout", () => {
		const gauge = contextGauge(361_000, 1_000_000);
		const line = [
			`${gauge.glyph}${GAP}${gauge.text}`,
			marginalText(0.42),
			sessionText(4.21),
		].join(GAP);

		expect(line).toBe("\u25d1 361k \u2202 $0.42 \u03a3 $4.21");
		expect(line).not.toContain("  ");
	});
});
