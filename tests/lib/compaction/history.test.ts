import { describe, expect, it } from "vitest";
import { compactionHistory } from "../../../lib/compaction/index.ts";

function turn(
	prompt: number,
	written = 0,
	cost?: { total: number; cacheRead: number },
) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 2,
				cacheRead: prompt - 2 - written,
				cacheWrite: written,
				...(cost ? { cost } : {}),
			},
		},
	};
}

function user() {
	return { type: "message", message: { role: "user", content: "hi" } };
}

function compaction(summariser?: string, output = 0) {
	return {
		type: "compaction",
		summary: "s",
		firstKeptEntryId: "x",
		tokensBefore: 1,
		usage: { output },
		details: summariser ? { summariser } : {},
	};
}

describe("reading a session's compaction history", () => {
	it("knows nothing about a session with no turns yet", () => {
		expect(compactionHistory([user()])).toMatchObject({
			turnsSinceCompaction: 0,
			retainedTokens: null,
			firstPromptTokens: null,
		});
	});

	it("counts every turn and keeps the first prompt when it has never compacted", () => {
		// The first prompt of a session is its fixed overhead, which is the
		// floor a compaction cannot go below.
		const history = compactionHistory([
			user(),
			turn(90_000),
			turn(95_000),
			turn(99_000),
		]);
		expect(history).toMatchObject({
			turnsSinceCompaction: 3,
			retainedTokens: null,
			firstPromptTokens: 90_000,
		});
	});

	it("counts turns since the last compaction and takes what it retained from the turn after it", () => {
		// The real failure: a resumed session read its whole resumed context
		// as the fixed prompt, so nothing ever looked droppable.
		const history = compactionHistory([
			turn(90_000),
			turn(600_000),
			compaction(),
			turn(140_000),
			turn(150_000),
			compaction(),
			turn(130_000),
			turn(200_000),
			turn(520_000),
		]);
		expect(history).toMatchObject({
			turnsSinceCompaction: 3,
			retainedTokens: 130_000,
			firstPromptTokens: 90_000,
		});
	});

	it("skips turns that carry no usage", () => {
		const history = compactionHistory([
			{ type: "message", message: { role: "assistant" } },
			turn(90_000),
		]);
		expect(history.firstPromptTokens).toBe(90_000);
		expect(history.turnsSinceCompaction).toBe(1);
	});

	it("reads what the last compaction cost, from the session's own record of it", () => {
		const history = compactionHistory([
			turn(90_000),
			turn(300_000),
			compaction("conversation", 7_000),
			turn(130_000, 88_000),
			turn(140_000),
			turn(150_000),
		]);
		// The prompts since, which pay rent on what a compaction would drop.
		expect(history.promptsSinceCompaction).toEqual([130_000, 140_000, 150_000]);
		// What the first turn after had to write back to cache.
		expect(history.rewriteTokens).toBe(88_000);
		// What the summary took to write, thinking included.
		expect(history.summaryOutputTokens).toBe(7_000);
	});

	it("does not take a summary length from a summariser other than the conversation's", () => {
		// pi's own writes two to three times as much; its length says
		// nothing about what the next summary will cost.
		const history = compactionHistory([
			turn(300_000),
			compaction(undefined, 20_000),
			turn(130_000, 88_000),
		]);
		expect(history.summaryOutputTokens).toBeNull();
	});

	it("averages what recent turns cost beyond reading their context", () => {
		const history = compactionHistory([
			turn(100_000, 0, { total: 0.07, cacheRead: 0.02 }),
			turn(110_000, 0, { total: 0.09, cacheRead: 0.02 }),
		]);
		expect(history.turnOverhead).toBeCloseTo(0.06, 10);
	});
});
