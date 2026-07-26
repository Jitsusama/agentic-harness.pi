/**
 * Network shaping. The throttle numbers are Chrome's own, taken
 * from its devtools source, so the tests check the values it
 * actually uses rather than round numbers that would look
 * tidier and be wrong.
 */

import { describe, expect, it } from "vitest";
import {
	matchesPattern,
	type NetworkRule,
	renderShaping,
	ruleFor,
	throttleNames,
	throttleProfile,
} from "../../../../lib/web/environment/shaping.js";

describe("throttleProfile", () => {
	it("goes properly offline", () => {
		expect(throttleProfile("offline")?.offline).toBe(true);
	});

	it("uses Chrome's own slow 3G numbers", () => {
		const slow = throttleProfile("slow-3g");
		expect(slow?.download).toBe(50000);
		expect(slow?.latency).toBe(2000);
	});

	it("uses Chrome's own slow 4G numbers", () => {
		const slow = throttleProfile("slow-4g");
		expect(slow?.download).toBe(180000);
		expect(slow?.upload).toBe(84375);
		expect(slow?.latency).toBe(562.5);
	});

	it("still answers to fast 3G, the name Chrome used before 2024", () => {
		expect(throttleProfile("fast-3g")).toEqual(throttleProfile("slow-4g"));
	});

	it("does not know a name nobody defined", () => {
		expect(throttleProfile("hyperspeed")).toBeUndefined();
	});

	it("offers its names", () => {
		expect(throttleNames()).toContain("slow-3g");
		expect(throttleNames()).toContain("offline");
	});
});

describe("matchesPattern", () => {
	it("matches everything under a star", () => {
		expect(matchesPattern("*", "http://a/b")).toBe(true);
	});

	it("matches a glob", () => {
		expect(matchesPattern("*/api/*", "http://a/api/data")).toBe(true);
		expect(matchesPattern("*.css", "http://a/style.css")).toBe(true);
	});

	it("matches a plain fragment, which is how people actually type", () => {
		expect(matchesPattern("/api/data", "http://a/api/data?x=1")).toBe(true);
	});

	it("does not match what it should not", () => {
		expect(matchesPattern("*.css", "http://a/script.js")).toBe(false);
	});

	it("treats regex characters in a pattern as literal text", () => {
		// A url is full of dots and question marks; a pattern that
		// read them as regex would match far too much.
		expect(matchesPattern("a.css", "http://x/aXcss")).toBe(false);
	});
});

describe("ruleFor", () => {
	const rules: readonly NetworkRule[] = [
		{ pattern: "*/api/health", action: "mock", status: 500 },
		{ pattern: "*/api/*", action: "mock", status: 200 },
		{ pattern: "*.png", action: "block" },
	];

	it("lets a specific rule win over a general one placed after it", () => {
		expect(ruleFor(rules, "http://a/api/health")?.status).toBe(500);
	});

	it("falls through to the general rule", () => {
		expect(ruleFor(rules, "http://a/api/other")?.status).toBe(200);
	});

	it("finds a block", () => {
		expect(ruleFor(rules, "http://a/logo.png")?.action).toBe("block");
	});

	it("returns nothing when no rule applies", () => {
		expect(ruleFor(rules, "http://a/index.html")).toBeUndefined();
	});
});

describe("renderShaping", () => {
	it("says when nothing is being done", () => {
		const out = renderShaping([], undefined);
		expect(out).toContain("unshaped");
		expect(out).toContain("No requests are being mocked or blocked");
	});

	it("says offline plainly", () => {
		expect(
			renderShaping([], { offline: true, download: 0, upload: 0, latency: 0 }),
		).toContain("offline");
	});

	it("reports the throttle in units a person reads", () => {
		const out = renderShaping([], {
			offline: false,
			download: 50000,
			upload: 50000,
			latency: 2000,
		});
		expect(out).toContain("2000ms latency");
		expect(out).toContain("KB/s");
	});

	it("lists the rules in the order they will be tried", () => {
		const out = renderShaping(
			[
				{ pattern: "*/api/*", action: "mock", status: 503 },
				{ pattern: "*.png", action: "block" },
			],
			undefined,
		);
		expect(out.indexOf("*/api/*")).toBeLessThan(out.indexOf("*.png"));
		expect(out).toContain("503");
	});
});
