import { describe, expect, it } from "vitest";
import {
	formatIndexOutcome,
	formatPaybackReplay,
	formatRegret,
	formatRepeats,
	formatSlices,
	formatTotal,
	formatVerifierOutcomes,
} from "../../extensions/cost-workflow/report.js";

describe("formatTotal", () => {
	it("names unmetered turns rather than folding them in as free", () => {
		const text = formatTotal({
			cost: 96_213,
			turns: 480_073,
			unmetered: 1830,
			cacheWriteTokens: 0,
			cacheWrite1hTokens: 0,
		});

		expect(text).toContain("$96,213");
		expect(text).toContain("480,073 turns");
		expect(text).toContain("1,830");
		expect(text).toContain("unknown amount");
	});

	it("reports the one-hour cache share, which proves retention is in force", () => {
		const text = formatTotal({
			cost: 10,
			turns: 5,
			unmetered: 0,
			cacheWriteTokens: 4_380_000_000,
			cacheWrite1hTokens: 0,
		});

		expect(text).toContain("4.38B tokens");
		expect(text).toContain("0.0% at the one-hour rate");
	});

	it("says nothing about caches when none were written", () => {
		const text = formatTotal({
			cost: 1,
			turns: 1,
			unmetered: 0,
			cacheWriteTokens: 0,
			cacheWrite1hTokens: 0,
		});

		expect(text).not.toContain("cache writes");
	});
});

describe("formatSlices", () => {
	it("keeps the unattributed slice visible with its share", () => {
		// Hiding it would make every named share a fraction of a total
		// that excluded it, which is how a misleading percentage is made.
		const text = formatSlices("Cost by quest", [
			{ key: "QEST-1", cost: 60, turns: 100 },
			{ key: "", cost: 40, turns: 50 },
		]);

		expect(text).toContain("1 named");
		expect(text).toContain("$40.00 unattributed");
		expect(text).toContain("40%");
	});

	it("shows cost per turn, the figure that actually varies", () => {
		const text = formatSlices("Cost by repo", [
			{ key: "world/system/gitstream", cost: 45_494, turns: 208_898 },
		]);

		expect(text).toContain("$0.218/turn");
		expect(text).toContain("208,898 turns");
	});

	it("says how many slices it did not show", () => {
		const slices = Array.from({ length: 20 }, (_, i) => ({
			key: `r${i}`,
			cost: 20 - i,
			turns: 1,
		}));

		const text = formatSlices("Cost by repo", slices, 5);

		expect(text).toContain("15 more");
	});

	it("reports an empty ledger as empty rather than as zero spend", () => {
		expect(formatSlices("Cost by repo", [])).toContain("nothing recorded");
	});
});

describe("formatRepeats", () => {
	it("reports no repeats as none, not as an empty table", () => {
		expect(formatRepeats([])).toContain("no repeated");
	});

	it("names the tool, the count and the weight, heaviest first", () => {
		const text = formatRepeats([
			{
				argsDigest: "a1b2c3",
				name: "read",
				asked: 3,
				repeated: 2,
				repeatedChars: 29_400_000,
			},
			{
				argsDigest: "d4e5f6",
				name: "bash",
				asked: 2,
				repeated: 1,
				repeatedChars: 500,
			},
		]);

		const lines = text.split("\n").filter((l) => l.includes("asked"));
		expect(lines[0]).toContain("read");
		expect(lines[0]).toContain("3");
		expect(lines[0]).toContain("29.4M");
		expect(lines[1]).toContain("bash");
	});
});

describe("formatRegret", () => {
	it("reports no regret as none, not as an empty table", () => {
		expect(formatRegret([])).toContain("no regret");
	});

	it("names the tool and how many times its dropped answer was re-fetched", () => {
		const text = formatRegret([
			{
				name: "read",
				argsDigest: "a1",
				sessionId: "s1",
				droppedAtTimestamp: "2026-09-21T17:00:00.000Z",
				reAskedAtTimestamp: "2026-09-21T18:00:00.000Z",
				resultChars: 900_000,
			},
		]);

		expect(text).toContain("read");
		expect(text).toContain("1");
	});
});

describe("formatVerifierOutcomes", () => {
	it("reports nothing verified rather than an empty table", () => {
		expect(formatVerifierOutcomes([])).toContain("nothing");
	});

	it("names each kind's pass rate, worst first", () => {
		const text = formatVerifierOutcomes([
			{ kind: "lint", passed: 9, failed: 1, unknown: 0 },
			{ kind: "test", passed: 5, failed: 5, unknown: 0 },
		]);

		const lines = text.split("\n").filter((l) => l.includes("passed"));
		expect(lines[0]).toContain("test");
		expect(lines[0]).toContain("50%");
		expect(lines[1]).toContain("lint");
	});

	it("names an unknown outcome separately from a failure", () => {
		const text = formatVerifierOutcomes([
			{ kind: "build", passed: 1, failed: 0, unknown: 3 },
		]);

		expect(text).toContain("3");
		expect(text).toContain("unknown");
	});
});

describe("formatPaybackReplay", () => {
	it("reports nothing to replay rather than a division by zero", () => {
		expect(
			formatPaybackReplay({
				compactions: 0,
				evaluable: 0,
				agreed: 0,
				disagreed: 0,
			}),
		).toContain("no compactions");
	});

	it("names how many were evaluable and how the test would have called them", () => {
		const text = formatPaybackReplay({
			compactions: 82,
			evaluable: 67,
			agreed: 67,
			disagreed: 0,
		});

		expect(text).toContain("82");
		expect(text).toContain("67");
		expect(text).toContain("0 declined");
	});
});

describe("formatIndexOutcome", () => {
	it("says what it skipped, so an instant pass is not mistaken for a failure", () => {
		const text = formatIndexOutcome({
			files: 1243,
			scanned: 2,
			skipped: 1241,
			lines: 400,
			unparseable: 0,
			inserted: 12,
			duplicates: 3,
			insertedCalls: 30,
			duplicateCalls: 5,
			insertedDropped: 2,
			seconds: 0.4,
		});

		expect(text).toContain("indexed 2 of 1243 logs");
		expect(text).toContain("1241 unchanged");
		expect(text).not.toContain("unreadable");
	});

	it("surfaces unreadable lines when there were any", () => {
		const text = formatIndexOutcome({
			files: 1,
			scanned: 1,
			skipped: 0,
			lines: 10,
			unparseable: 1,
			inserted: 9,
			duplicates: 0,
			insertedCalls: 9,
			duplicateCalls: 0,
			insertedDropped: 0,
			seconds: 1,
		});

		expect(text).toContain("1 lines unreadable");
	});
});
