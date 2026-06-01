import { describe, expect, it } from "vitest";
import {
	detectProseViolations,
	formatProseBlock,
} from "../../../lib/prose/index.js";

describe("formatProseBlock", () => {
	it("returns an empty string when there are no violations", () => {
		expect(formatProseBlock([])).toBe("");
	});

	it("names the emdash and tells the author to restructure", () => {
		const message = formatProseBlock(detectProseViolations("A pause — here."));
		expect(message).toContain("emdash");
		expect(message).toMatch(/restructure/i);
	});

	it("names each misspelling with its Canadian suggestion", () => {
		const message = formatProseBlock(
			detectProseViolations("Pick a color and a behavior."),
		);
		expect(message).toContain("color");
		expect(message).toContain("colour");
		expect(message).toContain("behavior");
		expect(message).toContain("behaviour");
	});

	it("points at the prose-standard skill", () => {
		const message = formatProseBlock(detectProseViolations("Pick a color."));
		expect(message).toContain("prose-standard");
	});

	it("deduplicates a spelling that appears more than once", () => {
		const message = formatProseBlock(
			detectProseViolations("color here and color there."),
		);
		// "color -> colour" should be named once, not twice.
		const occurrences = message.split("color -> colour").length - 1;
		expect(occurrences).toBe(1);
	});
});
