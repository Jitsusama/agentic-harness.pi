/**
 * The payload sits flush against the left margin.
 *
 * The body is the thing the gate exists to show, and it reads best the
 * way the guardian gates already show it: at the margin, at full width.
 * The inset stays on quoted context, where holding somebody else's words
 * off the margin is the point, and leaves the outgoing body, where it
 * only cost three columns and a visual difference from every
 * neighbouring gate.
 */

import { describe, expect, it } from "vitest";
import {
	type BodyRenderer,
	type GatePanel,
	gateLines,
} from "../../extensions/review-integration/render.js";
import { plainTheme } from "../lib/ui/fake-theme.js";

const WIDTH = 72;

/**
 * Hands lines through untouched, so what the test measures is the
 * gate's own contribution to the column and not the markdown
 * renderer's padding, which belongs to the renderer.
 */
const passthrough: BodyRenderer = (body) => body.split("\n");

/**
 * Render and keep the raw lines, since the claim is about columns.
 * The plain theme styles nothing, so column zero is column zero.
 */
function lines(panel: GatePanel): string[] {
	return gateLines(panel, plainTheme(), WIDTH, passthrough);
}

describe("the payload of a write gate", () => {
	it("starts at column zero, not held off the margin", () => {
		const drawn = lines({
			destination: "shop/world#2000980 · meteorite",
			payload: { body: "Fixed in 0671cb0." },
		});

		const body = drawn.find((line) => line.includes("Fixed in 0671cb0."));
		expect(body).toBeDefined();
		expect(body?.startsWith("Fixed")).toBe(true);
	});

	it("keeps quoted context inset, since quoting is the point there", () => {
		const drawn = lines({
			destination: "shop/world#2000980 · meteorite",
			context: [{ who: "C4 binks", body: "Why not a plain mutex?" }],
			payload: { body: "Fixed in 0671cb0." },
		});

		const quote = drawn.find((line) => line.includes("Why not a plain"));
		expect(quote).toBeDefined();
		expect(quote?.trimStart()).not.toBe(quote);
	});
});
