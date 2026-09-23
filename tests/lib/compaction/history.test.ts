import { describe, expect, it } from "vitest";
import { compactionHistory } from "../../../lib/compaction/index.ts";

function turn(prompt: number) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 2, cacheRead: prompt - 2, cacheWrite: 0 },
		},
	};
}

function user() {
	return { type: "message", message: { role: "user", content: "hi" } };
}

function compaction() {
	return {
		type: "compaction",
		summary: "s",
		firstKeptEntryId: "x",
		tokensBefore: 1,
	};
}

describe("reading a session's compaction history", () => {
	it("knows nothing about a session with no turns yet", () => {
		expect(compactionHistory([user()])).toEqual({
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
		expect(history).toEqual({
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
		expect(history).toEqual({
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
});
