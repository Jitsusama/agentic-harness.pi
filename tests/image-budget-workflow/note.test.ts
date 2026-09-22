import { describe, expect, it } from "vitest";
import {
	describeScaling,
	readDimensionNote,
	stripDimensionNote,
} from "../../extensions/image-budget-workflow/note.js";

describe("readDimensionNote", () => {
	it("reads the true original out of pi's own note", () => {
		// pi resizes before an extension sees the result, so the payload's
		// size is not the original. Its note is where the original
		// survives, and the whole correctness of the budget rests on
		// using it rather than what was handed over.
		const note = readDimensionNote(
			"[Image: original 3024x1964, displayed at 2000x1299. " +
				"Multiply coordinates by 1.51 to map to original image.]",
		);

		expect(note).toEqual({
			originalWidth: 3024,
			originalHeight: 1964,
			width: 2000,
			height: 1299,
		});
	});

	it("is not fooled by prose that merely mentions an image", () => {
		expect(readDimensionNote("the image was 3024x1964 originally")).toBeNull();
		expect(readDimensionNote("")).toBeNull();
		expect(
			readDimensionNote("[Image: original wide, displayed at tall.]"),
		).toBeNull();
	});
});

describe("stripDimensionNote", () => {
	it("lifts pi's note out of the block it shares with other prose", () => {
		// pi writes its note before the image and folds it into the same
		// text block as the tool's own first line, so looking at the block
		// after the image finds nothing and the stale note survives.
		const out = stripDimensionNote(
			"Read image file [image/png]\n" +
				"[Image: original 3024x1964, displayed at 2000x1299. " +
				"Multiply coordinates by 1.51 to map to original image.]",
		);

		expect(out.note?.originalWidth).toBe(3024);
		expect(out.text).toBe("Read image file [image/png]");
		expect(out.text).not.toContain("1.51");
	});

	it("leaves a block with no note exactly as it was", () => {
		const out = stripDimensionNote("Read image file [image/png]");

		expect(out.note).toBeNull();
		expect(out.text).toBe("Read image file [image/png]");
	});

	it("does not strip prose that merely discusses dimensions", () => {
		// A file being read might well be this very module. A detector that
		// matches talk about a string rather than the string itself has
		// already cost this investigation one wrong number.
		const prose = "the note reads original 3024x1964, displayed at 2000x1299";
		const out = stripDimensionNote(prose);

		expect(out.note).toBeNull();
		expect(out.text).toBe(prose);
	});
});

describe("describeScaling", () => {
	it("states the true original and the size actually sent", () => {
		// Two notes that each tell half the truth are worse than one: the
		// real factor here is 1.99, and neither pi's 1.51 nor a note about
		// the intermediate size says so.
		const text = describeScaling(
			{ width: 3024, height: 1964 },
			{ width: 1519, height: 987 },
		);

		expect(text).toContain("3024x1964");
		expect(text).toContain("1519x987");
		expect(text).toContain("1.99");
	});

	it("says which direction to multiply, so a coordinate maps correctly", () => {
		const text = describeScaling(
			{ width: 2000, height: 1000 },
			{ width: 1000, height: 500 },
		);

		expect(text).not.toBeNull();
		expect(text?.toLowerCase()).toContain("multiply");
		expect(text).toContain("2.00");
	});

	it("declines to divide by a degenerate size", () => {
		expect(
			describeScaling({ width: 100, height: 100 }, { width: 0, height: 0 }),
		).toBeNull();
	});
});
