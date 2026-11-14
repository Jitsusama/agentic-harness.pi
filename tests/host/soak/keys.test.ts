/**
 * Each hosted key beside plain pi's same one: the steady keys paired,
 * each conversation's first apart from the rest, with what a drawing
 * took over plain pi's key to its entry.
 */
import { describe, expect, it } from "vitest";
import { pairKeys } from "./keys.ts";

describe("keys beside plain pi's", () => {
	it("pairs steady keys with plain pi's, first keys apart, leaving out a wake's and a burst's", () => {
		const records = [
			{
				tag: "c0-t0",
				keyToAcceptedMs: 300,
				keyToDrawnMs: 320,
				plainKeyToAcceptedMs: 120,
			},
			{ tag: "c1-t0", keyToAcceptedMs: 250, keyToDrawnMs: 260 },
			{
				tag: "c0-t1",
				keyToAcceptedMs: 40,
				keyToDrawnMs: 45,
				plainKeyToAcceptedMs: 10,
			},
			{
				tag: "c0-t2",
				keyToAcceptedMs: 9_000,
				plainKeyToAcceptedMs: 10,
				woke: "key",
			},
			{
				tag: "c1-t1",
				keyToAcceptedMs: 800,
				plainKeyToAcceptedMs: 10,
				burst: true as const,
			},
			{ tag: "c1-t2", plainKeyToAcceptedMs: 10 },
		].map((one) => ({ promptAt: 0, answerAt: 0, hostedMs: 0, ...one }));
		expect(
			pairKeys(records),
			"two first keys, one later, the rest left out",
		).toEqual({
			first: {
				hosted: { count: 2, p50: 250, p99: 300 },
				plain: { count: 1, p50: 120, p99: 120 },
				paired: { count: 1, p50: 180, p99: 180, max: 180, unpaired: 1 },
				drawn: { count: 2, p50: 260, p99: 320 },
				drawnPaired: { count: 1, p50: 200, p99: 200, max: 200, unpaired: 1 },
			},
			later: {
				hosted: { count: 1, p50: 40, p99: 40 },
				plain: { count: 1, p50: 10, p99: 10 },
				paired: { count: 1, p50: 30, p99: 30, max: 30, unpaired: 0 },
				drawn: { count: 1, p50: 45, p99: 45 },
				drawnPaired: { count: 1, p50: 35, p99: 35, max: 35, unpaired: 0 },
			},
		});
	});
});
