import { describe, expect, it } from "vitest";
import { foldBehind, renderBehind } from "../../../../lib/web/audit/behind.js";

/**
 * A region builder. Pixels are RGBA, row-major, which is what a
 * decoded PNG hands over.
 */
function region(
	width: number,
	height: number,
	at: (x: number, y: number) => readonly [number, number, number],
): { width: number; height: number; data: Uint8Array } {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = at(x, y);
			const o = (y * width + x) * 4;
			data[o] = r;
			data[o + 1] = g;
			data[o + 2] = b;
			data[o + 3] = 255;
		}
	}
	return { width, height, data };
}

const WHITE = [255, 255, 255] as const;
const BLACK = [0, 0, 0] as const;

describe("foldBehind", () => {
	it("judges only where the glyphs landed, not the whole box", () => {
		// A box whose left half is black and right half is white, with
		// white text that only ever lands on the left. Judging the whole
		// box would find white on white and fail; judging the glyphs
		// finds white on black and passes.
		const bare = region(10, 1, (x) => (x < 5 ? BLACK : WHITE));
		const withText = region(10, 1, (x) =>
			x === 1 || x === 2 ? WHITE : x < 5 ? BLACK : WHITE,
		);

		const report = foldBehind({
			withText,
			bare,
			textColour: { r: 255, g: 255, b: 255 },
			sizing: { fontSizePx: 16, fontWeight: 400 },
			bar: "AA",
		});

		expect(report.glyphPixels).toBe(2);
		expect(report.worstRatio).toBeCloseTo(21, 0);
		expect(report.verdict).toBe("pass");
	});

	it("reports the worst place the text sits, not an average of them", () => {
		// Two glyph pixels, one on black and one on mid grey. An average
		// would pass; the worst of them is what a reader actually meets.
		const bare = region(4, 1, (x) => (x === 2 ? [119, 119, 119] : BLACK));
		const withText = region(4, 1, (x) => (x === 1 || x === 2 ? WHITE : BLACK));

		const report = foldBehind({
			withText,
			bare,
			textColour: { r: 255, g: 255, b: 255 },
			sizing: { fontSizePx: 16, fontWeight: 400 },
			bar: "AA",
		});

		expect(report.glyphPixels).toBe(2);
		// White on #777777 is about 4.48:1, under the 4.5 AA bar.
		expect(report.worstRatio).toBeLessThan(4.5);
		expect(report.verdict).toBe("fail");
	});

	it("says it cannot decide when the text left no mark", () => {
		// Hiding the text changed nothing, so either there is no text or
		// it was already invisible. Either way there is nothing to judge,
		// and inventing a ratio would be worse than admitting it.
		const flat = region(4, 1, () => BLACK);

		const report = foldBehind({
			withText: flat,
			bare: flat,
			textColour: { r: 255, g: 255, b: 255 },
			sizing: { fontSizePx: 16, fontWeight: 400 },
			bar: "AA",
		});

		expect(report.glyphPixels).toBe(0);
		expect(report.verdict).toBe("undecidable");
		expect(report.undecided).toBe("no-text-pixels");
	});

	it("declines to judge text whose own colour could not be read", () => {
		// The glyphs are plainly there: two pixels changed. What is
		// missing is the text colour, which a modern colour syntax can
		// defeat. Assuming one would produce a confident ratio for a
		// colour nobody read, so the only honest answer is no answer.
		const bare = region(10, 1, () => BLACK);
		const withText = region(10, 1, (x) => (x === 1 || x === 2 ? WHITE : BLACK));

		const report = foldBehind({
			withText,
			bare,
			textColour: undefined,
			sizing: { fontSizePx: 16, fontWeight: 400 },
			bar: "AA",
		});

		expect(report.verdict).toBe("undecidable");
		expect(report.undecided).toBe("unreadable-text-colour");
		// The mask still ran, so the pixel count is a measurement rather
		// than a stand-in for one. Reporting zero here would claim
		// something the fold never tested.
		expect(report.glyphPixels).toBe(2);
	});

	it("says which of the two undecidables it hit when rendering", () => {
		const bare = region(4, 1, () => BLACK);
		const withText = region(4, 1, (x) => (x === 1 ? WHITE : BLACK));
		const unreadable = renderBehind(
			foldBehind({
				withText,
				bare,
				textColour: undefined,
				sizing: { fontSizePx: 16, fontWeight: 400 },
				bar: "AA",
			}),
		);

		expect(unreadable).toContain("WARN");
		expect(unreadable).toMatch(/colour/i);
		// The other reason's wording must not be reused here: "changed no
		// pixels" would be a false statement about this region.
		expect(unreadable).not.toMatch(/changed no pixels/i);
	});

	it("holds large text to the lower bar the criterion gives it", () => {
		// White on #949494 is about 3.03:1: under 4.5 for body text and
		// over 3 for large text, so the sizing decides the verdict.
		const bare = region(4, 1, () => [148, 148, 148]);
		const withText = region(4, 1, (x) => (x === 1 ? WHITE : [148, 148, 148]));
		const input = {
			withText,
			bare,
			textColour: { r: 255, g: 255, b: 255 },
			bar: "AA",
		} as const;

		const body = foldBehind({
			...input,
			sizing: { fontSizePx: 16, fontWeight: 400 },
		});
		const large = foldBehind({
			...input,
			sizing: { fontSizePx: 24, fontWeight: 400 },
		});

		expect(body.verdict).toBe("fail");
		expect(large.verdict).toBe("pass");
	});

	it("counts a pixel as glyph however faintly the text touched it", () => {
		// An antialiased edge changes a channel by one. That pixel is
		// part of the text, and a threshold that ignored it would let a
		// thin glyph go unjudged.
		const bare = region(3, 1, () => [100, 100, 100]);
		const withText = region(3, 1, (x) =>
			x === 1 ? [101, 100, 100] : [100, 100, 100],
		);

		const report = foldBehind({
			withText,
			bare,
			textColour: { r: 255, g: 255, b: 255 },
			sizing: { fontSizePx: 16, fontWeight: 400 },
			bar: "AA",
		});

		expect(report.glyphPixels).toBe(1);
	});
});

describe("renderBehind", () => {
	it("opens with the verdict and says what it measured over", () => {
		const bare = region(4, 1, () => BLACK);
		const withText = region(4, 1, (x) => (x === 1 ? WHITE : BLACK));

		const text = renderBehind(
			foldBehind({
				withText,
				bare,
				textColour: { r: 255, g: 255, b: 255 },
				sizing: { fontSizePx: 16, fontWeight: 400 },
				bar: "AA",
			}),
		);

		expect(text.split("\n")[0]).toMatch(/^PASS/);
		expect(text).toMatch(/21(\.\d+)?:1/);
		// The count is what stops the number reading as a whole-box claim.
		expect(text).toContain("1 pixel");
	});

	it("admits an undecided region rather than dressing it as a pass", () => {
		const flat = region(4, 1, () => BLACK);

		const text = renderBehind(
			foldBehind({
				withText: flat,
				bare: flat,
				textColour: { r: 255, g: 255, b: 255 },
				sizing: { fontSizePx: 16, fontWeight: 400 },
				bar: "AA",
			}),
		);

		expect(text.split("\n")[0]).toMatch(/^WARN/);
		expect(text.toLowerCase()).toContain("no text");
	});
});
