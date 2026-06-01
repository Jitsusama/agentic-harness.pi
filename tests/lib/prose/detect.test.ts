import { describe, expect, it } from "vitest";
import { detectProseViolations } from "../../../lib/prose/index.js";

describe("detectProseViolations", () => {
	it("finds nothing in clean Canadian prose", () => {
		expect(
			detectProseViolations("The colour of the centre reflects our behaviour."),
		).toEqual([]);
	});

	it("flags an emdash", () => {
		const violations = detectProseViolations(
			"This is a pause — a dramatic one.",
		);
		expect(violations).toHaveLength(1);
		expect(violations[0].kind).toBe("emdash");
	});

	it("flags American spelling with a Canadian suggestion", () => {
		const violations = detectProseViolations("Pick a color for the behavior.");
		const spellings = violations.filter((v) => v.kind === "spelling");
		expect(spellings.map((v) => v.found).sort()).toEqual(["behavior", "color"]);
		const colour = spellings.find((v) => v.found === "color");
		expect(colour?.suggestion).toBe("colour");
	});

	it("flags -ise spellings but leaves Canadian -ize alone", () => {
		expect(
			detectProseViolations("We organise the data.")
				.filter((v) => v.kind === "spelling")
				.map((v) => v.suggestion),
		).toEqual(["organize"]);
		expect(detectProseViolations("We organize the data.")).toEqual([]);
	});

	it("does not flag false-positive lookalikes", () => {
		// surprise, noise, size, otherwise, wise must never be touched
		expect(
			detectProseViolations(
				"The size of the noise was a surprise; otherwise it was wise.",
			),
		).toEqual([]);
	});

	it("ignores code fences, inline code and URLs", () => {
		const text = [
			"Use the `color` property here.",
			"```css",
			"color: red;",
			"```",
			"See https://example.com/color/center for more.",
		].join("\n");
		expect(detectProseViolations(text)).toEqual([]);
	});

	it("still flags prose spelling outside code", () => {
		const text = "The `color` property sets the color of the text.";
		const spellings = detectProseViolations(text).filter(
			(v) => v.kind === "spelling",
		);
		// Only the prose "color" outside the backticks is flagged.
		expect(spellings).toHaveLength(1);
	});

	it("flags a literal \\u2014 escape as an emdash", () => {
		const violations = detectProseViolations(
			"This is a pause \\u2014 a sneaky one.",
		);
		expect(violations).toHaveLength(1);
		expect(violations[0].kind).toBe("emdash");
	});

	it("flags curly quotes with a straight-quote suggestion", () => {
		const violations = detectProseViolations(
			"She said \u201Chello\u201D and it\u2019s fine.",
		);
		const curly = violations.filter((v) => v.kind === "curly-quote");
		// Open and close curly double-quotes are two violations, plus
		// the curly apostrophe: three in total.
		expect(curly.map((v) => v.suggestion).sort()).toEqual(['"', '"', "'"]);
	});

	it("flags the Unicode ellipsis with a three-period suggestion", () => {
		const violations = detectProseViolations("Wait for it\u2026 done.");
		const ellipsis = violations.filter((v) => v.kind === "ellipsis");
		expect(ellipsis).toHaveLength(1);
		expect(ellipsis[0].suggestion).toBe("...");
	});

	it("ignores curly quotes and ellipsis inside code", () => {
		const text = [
			"`it\u2019s` and `a\u2026b`",
			"```",
			"x = \u201Cy\u201D",
			"```",
		].join("\n");
		expect(detectProseViolations(text)).toEqual([]);
	});
});
