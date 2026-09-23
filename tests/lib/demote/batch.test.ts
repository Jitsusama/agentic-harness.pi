import { describe, expect, it } from "vitest";
import { planBatch, type SizedMessage } from "../../../lib/demote/index.ts";

const STUB = 100;

function bash(id: string, chars: number): SizedMessage {
	return { role: "toolResult", toolCallId: id, toolName: "bash", chars };
}

function read(id: string, chars: number): SizedMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", chars };
}

function assistant(chars = 200): SizedMessage {
	return { role: "assistant", chars };
}

/** Prices shaped like a one-hour cache: write twenty times a read. */
const PRICES = { readPrice: 1, writePrice: 20 };

describe("planning a demotion batch", () => {
	it("finds nothing to do while every result is inside the kept window", () => {
		const decision = planBatch({
			messages: [
				assistant(),
				bash("t1", 50_000),
				assistant(),
				bash("t2", 50_000),
			],
			demoted: new Set(),
			keepRecent: 2,
			turnsElapsed: 100,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.fire).toBe(false);
		expect(decision.candidates).toEqual([]);
	});

	it("fires when the reads saved over the remaining turns outweigh re-writing the suffix", () => {
		// 50,000 chars dropped, read on each of 100 more turns, against a
		// suffix of a few hundred chars re-written once at 20x.
		const decision = planBatch({
			messages: [
				assistant(),
				bash("old", 50_000),
				assistant(),
				bash("new", 100),
			],
			demoted: new Set(),
			keepRecent: 1,
			turnsElapsed: 100,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.fire).toBe(true);
		expect(decision.candidates).toEqual(["old"]);
		expect(decision.droppedChars).toBe(50_000 - STUB);
		expect(decision.margin).toBeGreaterThan(1);
	});

	it("declines when the suffix it would re-write costs more than the reads it saves", () => {
		// The mistake the first version made on every turn: a small result
		// early in the prompt, a large suffix after it, and little session
		// left to earn back the rewrite.
		const decision = planBatch({
			messages: [
				assistant(),
				bash("old", 2_000),
				assistant(200_000),
				bash("new", 100),
			],
			demoted: new Set(),
			keepRecent: 1,
			turnsElapsed: 3,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.fire).toBe(false);
		expect(decision.candidates).toEqual(["old"]);
		expect(decision.margin).toBeLessThan(1);
	});

	it("counts the suffix as it would be sent, with earlier demotions already stubs", () => {
		const decision = planBatch({
			messages: [
				bash("frozen", 90_000),
				bash("old", 10_000),
				bash("between", 30_000),
				bash("new", 100),
			],
			demoted: new Set(["frozen", "between"]),
			keepRecent: 1,
			turnsElapsed: 50,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.candidates).toEqual(["old"]);
		// The stub left at "old", the stub already at "between", and "new".
		expect(decision.suffixChars).toBe(STUB + STUB + 100);
	});

	it("never picks a result already demoted", () => {
		const decision = planBatch({
			messages: [bash("frozen", 90_000), bash("new", 100)],
			demoted: new Set(["frozen"]),
			keepRecent: 1,
			turnsElapsed: 50,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.candidates).toEqual([]);
		expect(decision.fire).toBe(false);
	});

	it("only considers the tools it is told to, bash by default", () => {
		const decision = planBatch({
			messages: [read("r1", 90_000), bash("b1", 40_000), bash("new", 100)],
			demoted: new Set(),
			keepRecent: 1,
			turnsElapsed: 50,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.candidates).toEqual(["b1"]);
	});

	it("keeps candidates in the order they sit in the prompt", () => {
		const decision = planBatch({
			messages: [bash("a", 10_000), bash("b", 10_000), bash("new", 100)],
			demoted: new Set(),
			keepRecent: 1,
			turnsElapsed: 50,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.candidates).toEqual(["a", "b"]);
	});

	it("does not fire when stubbing would not make the result any smaller", () => {
		const decision = planBatch({
			messages: [bash("tiny", 40), bash("new", 100)],
			demoted: new Set(),
			keepRecent: 1,
			turnsElapsed: 1_000,
			stubChars: STUB,
			...PRICES,
		});
		expect(decision.fire).toBe(false);
		expect(decision.candidates).toEqual([]);
	});
});
