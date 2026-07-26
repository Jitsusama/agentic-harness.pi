/**
 * Waiting. The interesting cases are the unit mismatch between
 * the two clocks a request carries, and the insistence that a
 * timeout says what it saw instead.
 */

import { describe, expect, it } from "vitest";
import type { NetworkRequest } from "../../../../lib/web/telemetry/network.js";
import {
	inFlight,
	isIdle,
	renderWait,
} from "../../../../lib/web/wait/conditions.js";

const request = (over: Partial<NetworkRequest> = {}): NetworkRequest => ({
	id: "R1",
	url: "http://localhost/x",
	method: "GET",
	resourceType: "fetch",
	startedAt: 1000,
	state: "complete",
	requestHeaders: {},
	redirects: [],
	durationMs: 20,
	...over,
});

describe("inFlight", () => {
	it("counts only what has not finished", () => {
		expect(
			inFlight([
				request({ state: "complete" }),
				request({ id: "R2", state: "pending" }),
				request({ id: "R3", state: "failed" }),
			]),
		).toHaveLength(1);
	});

	it("treats a cancelled request as finished, because it is", () => {
		expect(inFlight([request({ state: "cancelled" })])).toHaveLength(0);
	});
});

describe("isIdle", () => {
	it("is idle when nothing has ever happened", () => {
		expect(isIdle([], 500, 1000)).toBe(true);
	});

	it("is busy while anything is outstanding", () => {
		expect(isIdle([request({ state: "pending" })], 500, 9999)).toBe(false);
	});

	it("is busy just after a request finishes", () => {
		// Finished at 1000 + 20ms. A tenth of a second later is not
		// long enough to call the page done.
		expect(isIdle([request()], 500, 1000.1)).toBe(false);
	});

	it("is idle once the quiet period has passed", () => {
		expect(isIdle([request()], 500, 1001)).toBe(true);
	});

	it("measures quiet from the last request, not the first", () => {
		const early = request({ startedAt: 1000, durationMs: 10 });
		const late = request({ id: "R2", startedAt: 1005, durationMs: 10 });
		expect(isIdle([early, late], 500, 1005.2)).toBe(false);
		expect(isIdle([early, late], 500, 1006)).toBe(true);
	});

	it("reads the two clocks in their own units", () => {
		// startedAt is seconds and durationMs is milliseconds. Adding
		// them without converting would put the end 2000 seconds out.
		const slow = request({ startedAt: 1000, durationMs: 2000 });
		expect(isIdle([slow], 100, 1002.5)).toBe(true);
	});
});

describe("renderWait", () => {
	it("says what it waited for and how long", () => {
		const out = renderWait({
			met: true,
			waitedMs: 240,
			condition: { kind: "selector", selector: "#done" },
		});
		expect(out).toContain("240ms");
		expect(out).toContain("#done");
	});

	it("leads with the thing that did not happen", () => {
		const out = renderWait({
			met: false,
			waitedMs: 10000,
			condition: { kind: "text", text: "Saved" },
		});
		expect(out).toContain("Gave up");
		expect(out).toContain("Saved");
	});

	it("reports what was true instead, which is the useful part", () => {
		const out = renderWait({
			met: false,
			waitedMs: 5000,
			condition: { kind: "idle", quietMs: 500 },
			saw: "3 requests are still in flight.",
		});
		expect(out).toContain("3 requests are still in flight.");
	});

	it("carries a detail the condition produced", () => {
		const out = renderWait({
			met: true,
			waitedMs: 120,
			condition: { kind: "request", pattern: "*/api/*" },
			detail: "It answered 201.",
		});
		expect(out).toContain("201");
	});

	it("names every condition it can be given", () => {
		const conditions = [
			{ kind: "selector", selector: "#a" },
			{ kind: "gone", selector: "#a" },
			{ kind: "text", text: "hi" },
			{ kind: "idle", quietMs: 500 },
			{ kind: "request", pattern: "*" },
			{ kind: "animations" },
			{ kind: "duration", ms: 100 },
		] as const;
		for (const condition of conditions) {
			const out = renderWait({ met: true, waitedMs: 1, condition });
			expect(out).not.toContain("undefined");
			expect(out.length).toBeGreaterThan(12);
		}
	});
});
