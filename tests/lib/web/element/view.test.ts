import { describe, expect, it } from "vitest";
import {
	normalizeBoxModel,
	renderBox,
	renderStyles,
	renderTrace,
	renderVisibility,
} from "../../../../lib/web/element/index.js";
import {
	normalizeCascade,
	traceProperty,
} from "../../../../lib/web/styles/index.js";

describe("renderVisibility", () => {
	it("states the verdict and its reason", () => {
		expect(
			renderVisibility({ state: "covered", because: "div id=veil covers it" }),
		).toBe("covered: div id=veil covers it");
	});
});

describe("renderBox", () => {
	it("reads the boxes from the inside out", () => {
		// A real element: each box contains the one inside it.
		const box = normalizeBoxModel({
			content: [30, 20, 96, 20, 96, 39, 30, 39],
			padding: [10, 10, 116, 10, 116, 49, 10, 49],
			border: [8, 8, 118, 8, 118, 51, 8, 51],
			margin: [0, 0, 126, 0, 126, 59, 0, 59],
			width: 110,
			height: 43,
		});
		expect(renderBox(box)).toBe(
			[
				"content 66 by 19 at (30, 20)",
				"padding 10 20",
				"border 2",
				"margin 8",
			].join("\n"),
		);
	});

	it("says nothing about a margin an element does not have", () => {
		const box = normalizeBoxModel({
			content: [0, 0, 10, 0, 10, 10, 0, 10],
			padding: [0, 0, 10, 0, 10, 10, 0, 10],
			border: [0, 0, 10, 0, 10, 10, 0, 10],
			margin: [0, 0, 10, 0, 10, 10, 0, 10],
			width: 10,
			height: 10,
		});
		expect(renderBox(box)).toBe("content 10 by 10 at (0, 0)");
	});
});

describe("renderStyles", () => {
	it("groups the entries as they were curated", () => {
		expect(
			renderStyles([
				{
					name: "box",
					entries: [{ property: "display", value: "flex" }],
				},
			]),
		).toBe("box\n  display: flex");
	});

	it("says plainly when an element sets nothing of its own", () => {
		expect(renderStyles([])).toBe("Nothing was set beyond the defaults.");
	});
});

describe("renderTrace", () => {
	it("marks the winner and says where each came from", () => {
		const declarations = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".card" },
						style: {
							cssProperties: [
								{
									name: "color",
									value: "navy",
									text: "color: navy",
									range: { startLine: 2, startColumn: 4 },
								},
							],
						},
					},
				},
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".muted" },
						style: {
							cssProperties: [
								{
									name: "color",
									value: "gray",
									text: "color: gray !important",
									important: true,
								},
							],
						},
					},
				},
			],
		});
		expect(
			renderTrace(traceProperty(declarations, "color", "rgb(1, 1, 1)")),
		).toBe(
			[
				"color computed to rgb(1, 1, 1)",
				"wins  color: gray !important  from .muted",
				"      color: navy  from .card  line 3",
			].join("\n"),
		);
	});

	it("says plainly when nothing declared the property", () => {
		expect(renderTrace({ property: "z-index", declarations: [] })).toBe(
			"Nothing declared z-index.",
		);
	});
});
