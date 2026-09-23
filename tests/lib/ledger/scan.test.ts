import { describe, expect, it } from "vitest";
import { readTurns } from "../../../lib/ledger/index.ts";

function assistantLine(
	id: string,
	total: number,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp: "2026-09-21T17:55:00.000Z",
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: {
				input: 4,
				output: 224,
				cacheRead: 1000,
				cacheWrite: 141937,
				totalTokens: 143165,
				cacheWrite1h: 141937,
				cost: {
					input: 0.00002,
					output: 0.0056,
					cacheRead: 0.0005,
					cacheWrite: 0.887,
					total,
				},
			},
			...extra,
		},
	});
}

describe("readTurns", () => {
	it("reads a billable assistant turn with its usage split by channel", () => {
		const scan = readTurns("s1", [assistantLine("a1", 0.89)]);

		expect(scan.turns).toHaveLength(1);
		const turn = scan.turns[0];
		expect(turn.entryId).toBe("a1");
		expect(turn.sessionId).toBe("s1");
		expect(turn.kind).toBe("assistant");
		expect(turn.model).toBe("claude-opus-5");
		expect(turn.cost?.total).toBe(0.89);
		expect(turn.tokens.cacheWrite).toBe(141937);
		expect(turn.cacheWrite1h).toBe(141937);
	});

	it("finds compaction usage at the top level, where the entry carries it", () => {
		// A compaction's usage sits beside `type`, not under `message`.
		// Reading only `message.usage` is how $221 of compaction cost was
		// missed for a week, so this is pinned by a test.
		const line = JSON.stringify({
			id: "c1",
			type: "compaction",
			timestamp: "2026-09-21T17:55:54.933Z",
			tokensBefore: 800_000,
			firstKeptEntryId: "a9",
			fromHook: false,
			usage: {
				input: 500_000,
				output: 3000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 2.5 },
			},
		});

		const scan = readTurns("s1", [line]);

		expect(scan.turns).toHaveLength(1);
		expect(scan.turns[0].kind).toBe("compaction");
		expect(scan.turns[0].cost?.total).toBe(2.5);
		expect(scan.turns[0].droppedBefore).toBe(800_000);
		expect(scan.turns[0].firstKeptEntryId).toBe("a9");
	});

	it("reports an unmetered turn as unknown cost rather than zero", () => {
		// A run that died before reporting usage costs an unknown amount.
		// Recording it as 0 understates the total and cannot be told apart
		// from a genuinely free turn.
		const line = JSON.stringify({
			id: "a2",
			type: "message",
			timestamp: "2026-09-21T17:56:00.000Z",
			message: { role: "assistant", model: "claude-opus-5" },
		});

		const scan = readTurns("s1", [line]);

		expect(scan.turns).toHaveLength(1);
		expect(scan.turns[0].cost).toBeNull();
		expect(scan.coverage.unmetered).toBe(1);
	});

	it("counts a line it cannot parse instead of abandoning the rest", () => {
		// One bad line at file 157 of 1,243 silently cut a corpus-wide
		// aggregate to 10 percent of the truth. A scan reports what it
		// could not read and keeps going.
		const scan = readTurns("s1", [
			assistantLine("a1", 1),
			"{not json at all",
			assistantLine("a3", 2),
		]);

		expect(scan.turns).toHaveLength(2);
		expect(scan.coverage.lines).toBe(3);
		expect(scan.coverage.unparseable).toBe(1);
		expect(scan.coverage.billable).toBe(2);
	});

	it("digests identical turns alike and differing turns apart", () => {
		const same = readTurns("s1", [assistantLine("a1", 1)]);
		const forked = readTurns("s2", [assistantLine("a1", 1)]);
		const other = readTurns("s1", [assistantLine("a9", 1)]);

		expect(same.turns[0].digest).toBe(forked.turns[0].digest);
		expect(same.turns[0].digest).not.toBe(other.turns[0].digest);
	});
});

describe("thinking level", () => {
	/** An entry placed in the session tree under a parent. */
	function under(parentId: string | null, line: string): string {
		return JSON.stringify({ ...JSON.parse(line), parentId });
	}

	function levelLine(
		id: string,
		parentId: string | null,
		level: string,
	): string {
		return JSON.stringify({
			type: "thinking_level_change",
			id,
			parentId,
			timestamp: "2026-09-21T17:55:00.000Z",
			thinkingLevel: level,
		});
	}

	it("gives each turn the level its branch last set, and null before any", () => {
		const scan = readTurns("s1", [
			under(null, assistantLine("a0", 1)),
			levelLine("t1", "a0", "high"),
			under("t1", assistantLine("a1", 1)),
			levelLine("t2", "a1", "low"),
			under("t2", assistantLine("a2", 1)),
		]);

		expect(scan.turns.map((t) => t.thinkingLevel)).toEqual([
			null,
			"high",
			"low",
		]);
	});

	it("keeps a level set on one branch out of its sibling", () => {
		// A session log is a tree: navigating back and branching leaves
		// the abandoned branch's lines in the file, before the new ones.
		const scan = readTurns("s1", [
			levelLine("t1", null, "high"),
			under("t1", assistantLine("a1", 1)),
			levelLine("t2", "a1", "xhigh"),
			under("t2", assistantLine("a2", 1)),
			under("a1", assistantLine("a3", 1)),
		]);

		expect(scan.turns.map((t) => [t.entryId, t.thinkingLevel])).toEqual([
			["a1", "high"],
			["a2", "xhigh"],
			["a3", "high"],
		]);
	});

	it("does not change a turn's address, so a rescan fills the level in place", () => {
		const before = readTurns("s1", [assistantLine("a1", 1)]);
		const after = readTurns("s1", [
			levelLine("t1", null, "high"),
			under("t1", assistantLine("a1", 1)),
		]);

		expect(after.turns[0].digest).toBe(before.turns[0].digest);
	});
});
