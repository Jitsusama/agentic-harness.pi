/**
 * The soak's pace: times drawn through a median and a 90th percentile, the
 * same for the same key, capped, and an answer streamed in pieces across
 * its drawn time, by the soak's provider over real HTTP.
 */
import { describe, expect, it } from "vitest";
import { drawn, LONGEST_MS, paceOf, piecesOf } from "./pace.ts";
import { answerTo, soakProvider } from "./soak-provider.ts";

const DRAWS = 10_000;
const MEDIAN = 4_000;
const NINETIETH = 12_000;
/** How far a percentile of ten thousand draws may sit from its mark. */
const WITHIN = 0.05;

/** The `p`th percentile of `values`. */
function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((p / 100) * sorted.length)] ?? Number.NaN;
}

describe("a pace", () => {
	it("reads a median and a 90th percentile, or the median alone", () => {
		expect(paceOf("4000,12000"), "both").toEqual({ p50: 4000, p90: 12000 });
		expect(paceOf("500"), "one").toEqual({ p50: 500, p90: 500 });
		expect(paceOf(undefined), "none given").toBeUndefined();
	});

	it("refuses a pace that isn't one", () => {
		expect(() => paceOf("0"), "no time").toThrow(/P50 above 0/);
		expect(() => paceOf("900,300"), "P90 under P50").toThrow(/P90 at least/);
		expect(() => paceOf("soon"), "not a number").toThrow(/P50\[,P90\]/);
	});

	it("draws times through its percentiles", () => {
		const spread = { p50: MEDIAN, p90: NINETIETH };
		const times = Array.from({ length: DRAWS }, (_, n) =>
			drawn(spread, `c0-t${n}`),
		);
		expect(percentile(times, 50) / MEDIAN, "the median").toBeCloseTo(1, 1);
		expect(
			Math.abs(percentile(times, 90) / NINETIETH - 1),
			"the 90th",
		).toBeLessThan(WITHIN);
		expect(Math.max(...times), "capped").toBeLessThanOrEqual(LONGEST_MS);
	});

	it("draws the same time for the same key", () => {
		const spread = { p50: MEDIAN, p90: NINETIETH };
		expect(drawn(spread, "c3-t41 first")).toBe(drawn(spread, "c3-t41 first"));
		expect(drawn(spread, "c3-t41 first")).not.toBe(
			drawn(spread, "c3-t41 after"),
		);
	});

	it("cuts words into pieces that join back into them", () => {
		expect(piecesOf("abcdefghij", 3), "three").toEqual(["abcd", "efgh", "ij"]);
		expect(piecesOf("ab", 5), "no more than its letters").toEqual(["a", "b"]);
		expect(piecesOf("", 4), "none still streams one").toEqual([""]);
		expect(piecesOf("abc", 0), "no time is one").toEqual(["abc"]);
	});
});

describe("the soak's provider at a pace", () => {
	const user = (text: string) => ({ role: "user", content: text });

	it("has a bash turn's command wait its drawn time first", () => {
		const tool = { p50: 500, p90: 500 };
		expect(answerTo([user("soak c0-t3 bash, please")], tool)).toEqual({
			type: "tool_use",
			name: "bash",
			input: { command: "sleep 0.500; echo soak bash c0-t3" },
		});
	});

	it("streams an answer in pieces across its drawn time", async () => {
		const answerMs = 400;
		const provider = await soakProvider({
			answer: { p50: answerMs, p90: answerMs },
		});
		try {
			const started = Date.now();
			const response = await fetch(`${provider.endpoint}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({
					messages: [user("soak c0-t11 long, please")],
				}),
			});
			const events = await response.text();
			const took = Date.now() - started;
			const pieces = [...events.matchAll(/"text_delta","text":("[^"]*")/g)];
			expect(pieces.length, "pieces, one each 50 ms").toBe(8);
			expect(
				pieces.map((one) => JSON.parse(one[1] ?? '""')).join(""),
				"the whole answer",
			).toMatch(/^line 1\n[\s\S]*ack c0-t11\.$/);
			expect(took, "its drawn time").toBeGreaterThanOrEqual(answerMs);
		} finally {
			await provider.close();
		}
	});
});
