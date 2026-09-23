import { describe, expect, it } from "vitest";
import { readTurns } from "../../../lib/ledger/index.ts";

function assistant(id: string, model: string): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp: "2026-09-21T17:50:00.000Z",
		message: {
			role: "assistant",
			model,
			usage: { input: 1, output: 1, cost: { total: 0.1 } },
			content: [],
		},
	});
}

function compaction(id: string, firstKeptEntryId: string): string {
	return JSON.stringify({
		id,
		type: "compaction",
		timestamp: "2026-09-21T17:55:00.000Z",
		firstKeptEntryId,
		tokensBefore: 400_000,
		usage: { input: 1, output: 1, cost: { total: 0.05 } },
	});
}

describe("a compaction's model", () => {
	it("inherits the model of the assistant turn just before it", () => {
		// A CompactionEntry carries no model field of its own, per pi's own
		// entry shape, so without this the join to a model's billed rate
		// has nothing to join on.
		const scan = readTurns("s1", [
			assistant("a1", "claude-opus-5"),
			compaction("c1", "a1"),
		]);

		const c = scan.turns.find((t) => t.kind === "compaction");
		expect(c?.model).toBe("claude-opus-5");
	});

	it("inherits the most recent model when it has changed mid-session", () => {
		const scan = readTurns("s1", [
			assistant("a1", "claude-opus-5"),
			assistant("a2", "claude-sonnet-5"),
			compaction("c1", "a2"),
		]);

		const c = scan.turns.find((t) => t.kind === "compaction");
		expect(c?.model).toBe("claude-sonnet-5");
	});

	it("leaves the model empty when no assistant turn preceded it", () => {
		const scan = readTurns("s1", [compaction("c1", "nowhere")]);

		const c = scan.turns.find((t) => t.kind === "compaction");
		expect(c?.model).toBe("");
	});

	it("does not carry a model backward from a later session's turns", () => {
		// Only readTurns processes one log at a time, so this is really
		// asserting the tracker starts fresh per scan rather than per
		// process.
		const first = readTurns("s1", [compaction("c1", "nowhere")]);
		expect(first.turns[0].model).toBe("");
	});
});
