/**
 * Memory the page is holding, and whether it is growing.
 */

import { describe, expect, it } from "vitest";
import {
	compareHeap,
	type HeapReading,
	renderHeap,
} from "../../../../lib/web/perf/heap.js";

const MB = 1024 * 1024;

const reading = (usedMb: number, collected = true): HeapReading => ({
	usedBytes: usedMb * MB,
	totalBytes: 64 * MB,
	collected,
	at: 1000,
});

describe("compareHeap", () => {
	it("reports growth against an earlier reading", () => {
		const compared = compareHeap(reading(12), reading(10));

		expect(compared.grewBy).toBe(2 * MB);
	});

	it("reports a fall as a fall rather than as negative growth", () => {
		const compared = compareHeap(reading(8), reading(10));

		expect(compared.grewBy).toBe(-2 * MB);
		expect(compared.direction).toBe("fell");
	});

	it("has no verdict without something to compare against", () => {
		// One reading is a number, not a trend. Calling a first
		// measurement stable would be the machine inventing news.
		const compared = compareHeap(reading(12));

		expect(compared.direction).toBe("unknown");
		expect(compared.grewBy).toBeUndefined();
	});

	it("will not call growth a leak when nothing was collected", () => {
		// Uncollected garbage looks exactly like a leak. Saying so
		// without a collection is the single most misleading thing
		// this could report.
		const compared = compareHeap(reading(12, false), reading(10, false));

		expect(compared.trustworthy).toBe(false);
	});

	it("trusts a comparison where both readings followed a collection", () => {
		const compared = compareHeap(reading(12), reading(10));

		expect(compared.trustworthy).toBe(true);
	});
});

describe("renderHeap", () => {
	it("reports megabytes, not bytes", () => {
		const rendered = renderHeap(compareHeap(reading(12)));

		expect(rendered).toContain("12");
		expect(rendered).not.toContain("12582912");
	});

	it("says growth is not evidence when no collection happened", () => {
		const rendered = renderHeap(
			compareHeap(reading(12, false), reading(10, false)),
		);

		expect(rendered.toLowerCase()).toContain("garbage");
	});

	it("names the growth when there is some to name", () => {
		const rendered = renderHeap(compareHeap(reading(12), reading(10)));

		expect(rendered).toContain("2");
		expect(rendered.toLowerCase()).toContain("grew");
	});
});
