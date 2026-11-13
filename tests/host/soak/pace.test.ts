/**
 * The soak's pace: times and rounds drawn through a median and a 90th
 * percentile, the same for the same key, capped, a turn worked through its
 * drawn rounds, and an answer streamed in pieces across its drawn time, by
 * the soak's provider over real HTTP.
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

	it("caps a draw at the most it is given", () => {
		const many = { p50: 100, p90: 100 };
		expect(drawn(many, "c0-t1 rounds", 60)).toBe(60);
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
	const called = { role: "assistant", content: [{ type: "tool_use" }] };
	const result = {
		role: "user",
		content: [{ type: "tool_result", content: "ok" }],
	};
	/** A turn's messages once `rounds` of its tools have answered. */
	const after = (prompt: string, rounds: number) => [
		user("soak c0-t0 echo, please"),
		{ role: "assistant", content: "heard" },
		user(prompt),
		...Array.from({ length: rounds }, () => [called, result]).flat(),
	];
	const four = { rounds: { p50: 4, p90: 4 } };

	it("has a bash turn's command wait its drawn time first", () => {
		const tool = { p50: 500, p90: 500 };
		expect(answerTo([user("soak c0-t3 bash, please")], { tool })).toEqual({
			type: "tool_use",
			name: "bash",
			input: { command: "sleep 0.500; echo soak bash c0-t3" },
		});
	});

	it("works an echo turn's drawn rounds before its own answer", () => {
		const prompt = "soak c0-t1 echo, please";
		const answers = [0, 1, 2, 3].map((n) => answerTo(after(prompt, n), four));
		expect(answers, "two bash, a read, then its own").toEqual([
			{
				type: "tool_use",
				name: "bash",
				input: { command: "echo soak round 0 c0-t1" },
			},
			{
				type: "tool_use",
				name: "bash",
				input: { command: "echo soak round 1 c0-t1" },
			},
			{ type: "tool_use", name: "read", input: { path: "notes.txt" } },
			{ type: "text", text: "heard, ack c0-t1." },
		]);
	});

	it("counts a tool turn's own call among its rounds", () => {
		const prompt = "soak c0-t3 bash, please";
		const answers = [1, 2, 3].map((n) => answerTo(after(prompt, n), four));
		expect(answers).toEqual([
			{
				type: "tool_use",
				name: "bash",
				input: { command: "echo soak round 1 c0-t3" },
			},
			{
				type: "tool_use",
				name: "bash",
				input: { command: "echo soak bash c0-t3" },
			},
			{ type: "text", text: "done, ack c0-t3." },
		]);
	});

	it("counts only the tools of the latest turn", () => {
		const earlier = [...after("soak c0-t1 echo, please", 3)];
		const latest = [...earlier, user("soak c0-t2 echo, please")];
		expect(answerTo(latest, four)).toEqual({
			type: "tool_use",
			name: "bash",
			input: { command: "echo soak round 0 c0-t2" },
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
