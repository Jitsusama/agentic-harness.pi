import { describe, expect, it } from "vitest";
import {
	type BaselineProvenance,
	describeDrift,
	parse,
	sidecarFor,
	stringify,
} from "../../../../lib/web/compare/provenance.js";

const cart: BaselineProvenance = {
	url: "https://shop.example/cart",
	width: 1280,
	height: 720,
	deviceScaleFactor: 1,
};

describe("a baseline is comparable only to the same subject", () => {
	it("refuses a comparison against a different page", () => {
		// The failure this exists to stop: record on one page,
		// navigate, compare, and every difference between two
		// unrelated pages is reported as a regression with regions
		// attributed to real elements of the wrong one.
		const drift = describeDrift(cart, {
			...cart,
			url: "https://shop.example/checkout",
		});

		expect(drift).toContain("/cart");
		expect(drift).toContain("/checkout");
	});

	it("refuses a comparison at a different viewport", () => {
		expect(describeDrift(cart, { ...cart, width: 375 })).toContain("375");
	});

	it("refuses a comparison at a different pixel ratio", () => {
		// Nothing about the page changed, but every edge is
		// rasterized differently, so the diff is meaningless.
		expect(describeDrift(cart, { ...cart, deviceScaleFactor: 2 })).toContain(
			"2x",
		);
	});

	it("compares when the conditions match", () => {
		expect(describeDrift(cart, { ...cart })).toBeUndefined();
	});
});

describe("provenance survives a round trip", () => {
	it("reads back what it wrote", () => {
		expect(parse(stringify(cart))).toEqual(cart);
	});

	it("keeps an absent viewport absent rather than inventing one", () => {
		const noViewport: BaselineProvenance = {
			url: "https://shop.example/cart",
			deviceScaleFactor: 1,
		};

		expect(parse(stringify(noViewport))).toEqual(noViewport);
	});

	it("treats an unreadable sidecar as no sidecar", () => {
		// A baseline recorded before provenance existed has none,
		// and discarding those would make an upgrade lose data.
		expect(parse("{ truncated")).toBeUndefined();
		expect(parse("null")).toBeUndefined();
		expect(parse('{"url":"x"}')).toBeUndefined();
	});

	it("puts the sidecar beside the image it describes", () => {
		expect(sidecarFor("/baselines/default/cart.png")).toBe(
			"/baselines/default/cart.png.json",
		);
	});
});
