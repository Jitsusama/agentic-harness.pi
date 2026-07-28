import { describe, expect, it } from "vitest";
import {
	BYTES_PER_PIXEL,
	foldLayers,
	type LayerFacts,
	renderLayers,
} from "../../../../lib/web/perf/layers.js";

/**
 * A tree shaped like the one Chrome actually sent.
 *
 * Taken from a real capture: the root layer has no size, the
 * viewport and scrolling layers draw nothing despite being large,
 * and one promoted element comes back with no reason at all.
 */
const FACTS: LayerFacts = {
	layers: [
		{
			layerId: "6",
			width: 0,
			height: 0,
			paintCount: 0,
			drawsContent: true,
		},
		{
			layerId: "7",
			parentLayerId: "6",
			width: 800,
			height: 600,
			paintCount: 0,
			drawsContent: false,
		},
		{
			layerId: "12",
			parentLayerId: "6",
			width: 200,
			height: 120,
			paintCount: 1,
			drawsContent: true,
			backendNodeId: 41,
		},
		{
			layerId: "14",
			parentLayerId: "6",
			width: 80,
			height: 40,
			paintCount: 3,
			drawsContent: true,
			backendNodeId: 42,
		},
		{
			layerId: "15",
			parentLayerId: "6",
			width: 1400,
			height: 1600,
			paintCount: 1,
			drawsContent: true,
			backendNodeId: 43,
		},
		{
			layerId: "20",
			parentLayerId: "6",
			width: 120,
			height: 60,
			paintCount: 1,
			drawsContent: true,
			backendNodeId: 44,
		},
	],
	reasons: {
		"7": ["Is a scrollable overflow element using accelerated scrolling."],
		"12": ["Has a will-change: transform compositing hint."],
		"14": ["Overlaps other composited content."],
		"15": ["Has a will-change: transform compositing hint."],
		"20": [],
	},
	elements: {
		"12": "div.hint",
		"14": "div.fixed",
		"15": "div.huge",
		"20": "div#a",
	},
};

describe("foldLayers", () => {
	it("counts only the layers that actually draw toward memory", () => {
		const report = foldLayers(FACTS);

		// The 800x600 layer that draws nothing holds no texture, so
		// billing the page 1.9 MB for it would be inventing a cost.
		const drawn = FACTS.layers.filter(
			(layer) => layer.drawsContent && layer.width > 0,
		);
		const expected = drawn.reduce(
			(total, layer) => total + layer.width * layer.height * BYTES_PER_PIXEL,
			0,
		);

		expect(report.memoryBytes).toBe(expected);
		expect(report.drawing).toBe(drawn.length);
	});

	it("keeps every layer, drawing or not", () => {
		expect(foldLayers(FACTS).layers).toHaveLength(FACTS.layers.length);
	});

	it("groups layers by the reason Chrome gave", () => {
		const byReason = foldLayers(FACTS).byReason;
		const hint = byReason.find((entry) =>
			entry.reason.includes("will-change: transform"),
		);

		expect(hint?.count).toBe(2);
	});

	it("leads with the reason accounting for the most layers", () => {
		const report = foldLayers({
			...FACTS,
			reasons: {
				"7": ["Overlaps other composited content."],
				"12": ["Overlaps other composited content."],
				"14": ["Overlaps other composited content."],
				"15": ["Has a will-change: transform compositing hint."],
				"20": [],
			},
		});

		expect(report.byReason[0]?.reason).toContain("Overlaps");
		expect(report.byReason[0]?.count).toBe(3);
	});

	it("counts a promoted layer Chrome would not explain", () => {
		// Chrome returns no reason for a translateZ(0) layer, measured.
		// That is silence about a real layer, not evidence the layer is
		// unpromoted, and the two must not be conflated.
		expect(foldLayers(FACTS).unexplained).toBe(1);
	});

	it("orders layers by the memory they hold", () => {
		const report = foldLayers(FACTS);
		const held = report.layers.map((layer) => layer.memoryBytes);

		expect(held).toEqual([...held].sort((a, b) => b - a));
	});

	it("names the element a layer belongs to when one is known", () => {
		const report = foldLayers(FACTS);
		const huge = report.layers.find((layer) => layer.id === "15");

		expect(huge?.element).toBe("div.huge");
	});
});

describe("renderLayers", () => {
	it("opens with the count and the memory they hold", () => {
		const text = renderLayers(foldLayers(FACTS));

		expect(text).toContain("6 layers");
		expect(text).toMatch(/MB|KB/);
	});

	it("says how many layers Chrome would not explain", () => {
		expect(renderLayers(foldLayers(FACTS))).toContain("no reason");
	});

	it("says nothing about unexplained layers when all were explained", () => {
		const report = foldLayers({
			...FACTS,
			reasons: {
				...FACTS.reasons,
				"20": ["Overlaps other composited content."],
			},
		});

		expect(renderLayers(report)).not.toContain("no reason");
	});

	it("reports a page with nothing composited without inventing a total", () => {
		const text = renderLayers(
			foldLayers({ layers: [], reasons: {}, elements: {} }),
		);

		expect(text).toContain("No composited layers");
	});
});
