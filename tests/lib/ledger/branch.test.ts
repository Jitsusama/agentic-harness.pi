import { describe, expect, it } from "vitest";
import { RESUME_TEXT } from "../../../lib/compaction/index.ts";
import { readTurns } from "../../../lib/ledger/index.ts";

/**
 * A session log built entry by entry, each the child of the one before
 * unless told otherwise, a second apart from one o'clock.
 */
class Log {
	readonly lines: string[] = [];
	private last: string | null = null;
	private second = 0;

	add(
		id: string,
		body: Record<string, unknown>,
		options: { parent?: string | null; at?: string } = {},
	): this {
		this.second += 1;
		const parentId = options.parent === undefined ? this.last : options.parent;
		const timestamp =
			options.at ??
			new Date(Date.UTC(2026, 8, 24, 13, 0, this.second)).toISOString();
		this.lines.push(JSON.stringify({ id, parentId, timestamp, ...body }));
		this.last = id;
		return this;
	}

	typed(id: string, text = "please fix it", options = {}): this {
		return this.message(
			id,
			{ role: "user", content: [{ type: "text", text }] },
			options,
		);
	}

	resumed(id: string): this {
		return this.message(id, {
			role: "user",
			content: [{ type: "text", text: `${RESUME_TEXT}\n\n[quest context]` }],
		});
	}

	turn(
		id: string,
		options: {
			output?: number;
			at?: string;
			parent?: string | null;
			content?: unknown[];
		} = {},
	): this {
		return this.message(
			id,
			{
				role: "assistant",
				model: "claude-opus-5-5",
				stopReason: "toolUse",
				content: options.content ?? [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "ok" },
				],
				usage: {
					input: 0,
					output: options.output ?? 100,
					cacheRead: 50_000,
					cacheWrite: 1000,
					cost: { total: 0.02 },
				},
			},
			options,
		);
	}

	aborted(id: string): this {
		return this.message(id, {
			role: "assistant",
			model: "claude-opus-5-5",
			stopReason: "aborted",
			errorMessage: "Operation aborted",
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		});
	}

	result(id: string, text: string): this {
		return this.message(id, {
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text }],
		});
	}

	message(
		id: string,
		message: Record<string, unknown>,
		options: { parent?: string | null; at?: string } = {},
	): this {
		return this.add(id, { type: "message", message }, options);
	}
}

function facts(log: Log) {
	return new Map(
		readTurns("s1", log.lines).turns.map((turn) => [turn.entryId, turn]),
	);
}

describe("what came before a turn", () => {
	it("estimates what was new since the turn before it", () => {
		const turns = facts(
			new Log()
				.typed("u1", "x".repeat(40))
				.turn("a1", { output: 250 })
				.result("r1", "y".repeat(4000))
				.turn("a2"),
		);

		expect(turns.get("a1")?.facts).toMatchObject({
			precededBy: null,
			gapMs: null,
			newTokens: null,
			runTurn: 1,
			thinkingChars: 3,
			textChars: 2,
		});
		expect(turns.get("a2")?.facts).toMatchObject({
			precededBy: "results",
			gapMs: 2000,
			// A thousand tokens of result, and the previous turn's own output.
			newTokens: 1000 + 250,
			stopReason: "toolUse",
			runTurn: 2,
		});
	});

	it("names the most telling of what stood in between", () => {
		const log = new Log()
			.typed("u1")
			.turn("a1")
			.add("m1", { type: "model_change", modelId: "claude-sonnet-5" })
			.typed("u2")
			.turn("a2")
			.message("s1", {
				role: "system",
				content: "",
				toolsAdded: [{ name: "read" }],
			})
			.typed("u3")
			.turn("a3")
			.message("s2", { role: "system", content: "", sections: {} })
			.turn("a4")
			.typed("u4")
			.turn("a5")
			.turn("a6");

		const turns = facts(log);

		expect(
			["a2", "a3", "a4", "a5", "a6"].map(
				(id) => turns.get(id)?.facts?.precededBy,
			),
		).toEqual(["model", "tools", "system", "typed", "nothing"]);
	});

	it("follows the branch a turn is on, not the order of the lines", () => {
		const log = new Log()
			.typed("u1")
			.turn("a1")
			.result("r1", "z".repeat(40_000))
			.turn("a2")
			// Back on the branch at a1, as a tree navigation leaves it.
			.typed("u2", "try another way", { parent: "a1" })
			.turn("a3");

		const a3 = facts(log).get("a3")?.facts;

		expect(a3?.precededBy).toBe("typed");
		// The 10k-token result sits on the abandoned branch, not this one.
		expect(a3?.newTokens).toBeLessThan(200);
		expect(a3?.gapMs).toBe(4000);
	});

	it("does not let a request that never reached the model reset the estimate", () => {
		const turns = facts(
			new Log()
				.typed("u1")
				.turn("a1", { output: 0 })
				.result("r1", "y".repeat(400))
				.aborted("a2")
				.turn("a3"),
		);

		expect(turns.get("a2")?.facts?.newTokens).toBeNull();
		expect(turns.get("a3")?.facts).toMatchObject({
			newTokens: 100,
			runTurn: 3,
		});
	});
});

describe("runs", () => {
	it("starts a run at a typed message and carries it through a resume", () => {
		const log = new Log()
			.typed("u1")
			.turn("a1")
			.turn("a2")
			.add("c1", { type: "compaction", tokensBefore: 200_000, summary: "s" })
			.resumed("u2")
			.turn("a3")
			.typed("u3")
			.turn("a4");

		const turns = facts(log);
		const run = turns.get("a1")?.facts?.runId;

		expect(run).toBe("2026-09-24T13:00:01.000Z#u1");
		expect(turns.get("a3")?.facts).toMatchObject({ runId: run, runTurn: 3 });
		expect(turns.get("c1")?.facts).toMatchObject({ runId: run, runTurn: 2 });
		expect(turns.get("a4")?.facts).toMatchObject({ runTurn: 1 });
		expect(turns.get("a4")?.facts?.runId).not.toBe(run);
		expect(turns.get("a3")?.facts?.precededBy).toBe("compaction");
	});
});

describe("what surrounded a compaction", () => {
	it("reads how the summary was written and what the request in flight did", () => {
		const log = new Log()
			.typed("u1", "go", { at: "2026-09-24T13:00:00.000Z" })
			.turn("a1", { at: "2026-09-24T13:10:00.000Z" })
			.aborted("a2")
			.add(
				"c1",
				{
					type: "compaction",
					tokensBefore: 240_000,
					summary: "s".repeat(16_000),
					details: {
						written: "ahead",
						summariser: "conversation",
						summaryMs: 58_000,
						waitedMs: 0,
					},
				},
				{ at: "2026-09-24T13:18:00.000Z" },
			)
			.resumed("u2");

		const compaction = facts(log).get("c1")?.compaction;

		expect(compaction).toEqual({
			written: "ahead",
			summariser: "conversation",
			summaryMs: 58_000,
			waitedMs: 0,
			summaryChars: 16_000,
			abortedRequest: true,
			resumed: true,
			sinceTypedMs: 18 * 60_000,
		});
	});

	it("says a run was not resumed when somebody typed first", () => {
		const log = new Log()
			.typed("u1")
			.turn("a1")
			.add("c1", { type: "compaction", tokensBefore: 240_000, summary: "s" })
			.typed("u2");

		expect(facts(log).get("c1")?.compaction).toMatchObject({
			abortedRequest: false,
			resumed: false,
		});
	});

	it("leaves resumed unknown while the log has not said", () => {
		const log = new Log()
			.typed("u1")
			.turn("a1")
			.add("c1", { type: "compaction", tokensBefore: 240_000, summary: "s" });

		expect(facts(log).get("c1")?.compaction?.resumed).toBeNull();
	});
});
