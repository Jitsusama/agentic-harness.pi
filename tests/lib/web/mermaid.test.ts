import { describe, expect, it } from "vitest";
import {
	loadMermaidSource,
	MermaidRenderError,
	pngPixelSize,
	pngRenderScale,
} from "../../../lib/web/mermaid.js";

const MAX_LONG_EDGE = 2576;
const MAX_PIXELS = 3_750_000;
const MAX_UPSCALE = 4;

describe("pngRenderScale", () => {
	it("scales a tiny diagram up to the upscale ceiling, not past it", () => {
		expect(pngRenderScale({ width: 100, height: 80 })).toBe(MAX_UPSCALE);
	});

	it("holds a wide diagram at the long-edge cap", () => {
		const scale = pngRenderScale({ width: 5000, height: 1000 });
		expect(Math.round(5000 * scale)).toBe(MAX_LONG_EDGE);
		expect(5000 * scale).toBeLessThanOrEqual(MAX_LONG_EDGE);
	});

	it("holds a squarish diagram at the megapixel cap", () => {
		const scale = pngRenderScale({ width: 3000, height: 3000 });
		expect(3000 * scale * (3000 * scale)).toBeLessThanOrEqual(MAX_PIXELS + 1);
		// The long edge is comfortably under its own cap: area binds first.
		expect(3000 * scale).toBeLessThan(MAX_LONG_EDGE);
	});

	it("never crosses either cap for a medium diagram", () => {
		const scale = pngRenderScale({ width: 1000, height: 800 });
		expect(1000 * scale).toBeLessThanOrEqual(MAX_LONG_EDGE);
		expect(1000 * scale * (800 * scale)).toBeLessThanOrEqual(MAX_PIXELS + 1);
		expect(scale).toBeLessThanOrEqual(MAX_UPSCALE);
	});

	it("falls back to a scale of 1 for degenerate dimensions", () => {
		expect(pngRenderScale({ width: 0, height: 0 })).toBe(1);
		expect(pngRenderScale({ width: -10, height: 100 })).toBe(1);
	});
});

describe("pngPixelSize", () => {
	// Every case must hold both caps on the FINAL integer dimensions, not
	// just the unrounded ones: rounding each axis independently can push a
	// diagram over the area cap, which is the bug this guards against.
	const cases: Array<[string, { width: number; height: number }]> = [
		["tiny square", { width: 100, height: 80 }],
		["wide banner", { width: 5000, height: 1000 }],
		["large square", { width: 3000, height: 3000 }],
		["medium", { width: 1000, height: 800 }],
		// The regression case: unrounded 1455.9 x 2575.8, which naive rounding
		// turns into 1456 x 2576 = 3,750,656 px, over the 3.75MP cap.
		["area-cap rounding edge", { width: 364, height: 644 }],
	];

	for (const [name, intrinsic] of cases) {
		it(`keeps ${name} within both caps after integer rounding`, () => {
			const { width, height } = pngPixelSize(intrinsic);
			expect(Number.isInteger(width)).toBe(true);
			expect(Number.isInteger(height)).toBe(true);
			expect(width).toBeGreaterThanOrEqual(1);
			expect(height).toBeGreaterThanOrEqual(1);
			expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_LONG_EDGE);
			expect(width * height).toBeLessThanOrEqual(MAX_PIXELS);
		});
	}
});

describe("loadMermaidSource error mapping", () => {
	it("maps a rejected fetch to a network MermaidRenderError", async () => {
		const rejecting = (() =>
			Promise.reject(new Error("offline"))) as unknown as typeof fetch;

		await expect(loadMermaidSource(rejecting)).rejects.toThrow(
			MermaidRenderError,
		);
		await expect(loadMermaidSource(rejecting)).rejects.toThrow(/network/i);
	});

	it("names the HTTP status when the response is not ok", async () => {
		const notOk = (() =>
			Promise.resolve({ ok: false, status: 503 })) as unknown as typeof fetch;

		await expect(loadMermaidSource(notOk)).rejects.toThrow(/HTTP 503/);
	});
});
