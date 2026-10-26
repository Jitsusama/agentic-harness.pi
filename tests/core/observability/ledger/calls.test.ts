import { describe, expect, it } from "vitest";
import {
	openTurnStore,
	type ToolCallRecord,
} from "../../../../lib/core/observability/ledger/index.ts";

function call(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
	return {
		digest: "c1",
		sessionId: "s1",
		entryId: "a1",
		callId: "t1",
		timestamp: "2026-09-21T17:55:00.000Z",
		name: "bash",
		argsDigest: "args-ls",
		path: null,
		resultChars: 100,
		resultDigest: "res-1",
		isError: false,
		verifierKind: null,
		...overrides,
	};
}

describe("tool calls in the store", () => {
	it("round-trips a call with every field intact", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([call({ path: "/src/a.ts", isError: true })]);

		const [row] = await store.queryCalls();
		expect(row).toEqual(call({ path: "/src/a.ts", isError: true }));
		await store.close();
	});

	it("bills a call once however many logs hold it", async () => {
		// Forked logs repeat a call verbatim, digest included, the same
		// way they repeat a turn.
		const store = await openTurnStore(":memory:");
		const first = await store.recordCalls([call()]);
		const again = await store.recordCalls([call({ sessionId: "fork" })]);

		expect(first.inserted).toBe(1);
		expect(again.inserted).toBe(0);
		expect(await store.queryCalls()).toHaveLength(1);
		await store.close();
	});

	it("keeps an unanswered call, with its result unknown rather than empty", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ resultChars: null, resultDigest: null, isError: null }),
		]);

		const [row] = await store.queryCalls();
		expect(row.resultChars).toBeNull();
		expect(row.isError).toBeNull();
		await store.close();
	});

	it("names arguments asked more than once in one session, heaviest first", async () => {
		// The answer was already in the context when the call was made, so
		// the result was admitted twice. No value judgement is involved,
		// which is what makes this safe to act on.
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", argsDigest: "ls", resultChars: 10 }),
			call({ digest: "c2", argsDigest: "ls", resultChars: 10 }),
			call({ digest: "c3", argsDigest: "big", resultChars: 500 }),
			call({ digest: "c4", argsDigest: "big", resultChars: 500 }),
			call({ digest: "c5", argsDigest: "big", resultChars: 500 }),
			call({ digest: "c6", argsDigest: "once", resultChars: 9000 }),
		]);

		const repeats = await store.repeatedCalls();
		expect(repeats).toHaveLength(2);
		expect(repeats[0]).toMatchObject({
			argsDigest: "big",
			name: "bash",
			asked: 3,
			repeated: 2,
			repeatedChars: 1000,
		});
		expect(repeats[1].argsDigest).toBe("ls");
		await store.close();
	});

	it("does not call the same arguments in two sessions a repeat", async () => {
		// A second session has none of the first session's context, so
		// asking again is the only way it could know.
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", sessionId: "s1", argsDigest: "ls" }),
			call({ digest: "c2", sessionId: "s2", argsDigest: "ls" }),
		]);

		expect(await store.repeatedCalls()).toEqual([]);
		await store.close();
	});

	it("scopes repeats to the retrieval tools named", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", name: "read", argsDigest: "r" }),
			call({ digest: "c2", name: "read", argsDigest: "r" }),
			call({ digest: "c3", name: "tdd_loop", argsDigest: "green" }),
			call({ digest: "c4", name: "tdd_loop", argsDigest: "green" }),
		]);

		const repeats = await store.repeatedCalls({ retrieval: ["read"] });
		expect(repeats.map((r) => r.name)).toEqual(["read"]);
		await store.close();
	});

	it("does not count a re-read after a write to the same file as a repeat", async () => {
		// Re-reading unchanged bytes is waste; re-reading a file that was
		// just edited is how the edit gets checked.
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({
				digest: "c1",
				name: "read",
				argsDigest: "r",
				path: "/a",
				timestamp: "2026-09-21T17:00:00.000Z",
			}),
			call({
				digest: "w1",
				name: "edit",
				argsDigest: "e",
				path: "/a",
				timestamp: "2026-09-21T17:01:00.000Z",
			}),
			call({
				digest: "c2",
				name: "read",
				argsDigest: "r",
				path: "/a",
				timestamp: "2026-09-21T17:02:00.000Z",
			}),
			call({
				digest: "c3",
				name: "read",
				argsDigest: "r",
				path: "/a",
				resultChars: 40,
				timestamp: "2026-09-21T17:03:00.000Z",
			}),
		]);

		const repeats = await store.repeatedCalls({
			retrieval: ["read"],
			writers: ["edit"],
		});
		// Only the third read repeats unchanged bytes.
		expect(repeats).toHaveLength(1);
		expect(repeats[0]).toMatchObject({ repeated: 1, repeatedChars: 40 });
		await store.close();
	});

	describe("rework against appraisal", () => {
		// A repeat with a verifier between it and the last time the same
		// thing was asked is the model checking its work, which is cost of
		// quality, not waste. Only a repeat with none between is rework.
		const at = (minute: number) =>
			`2026-09-21T17:${String(minute).padStart(2, "0")}:00.000Z`;

		it("calls a repeat with nothing between it and the last ask rework", async () => {
			const store = await openTurnStore(":memory:");
			await store.recordCalls([
				call({ digest: "c1", name: "read", argsDigest: "r", timestamp: at(0) }),
				call({
					digest: "c2",
					name: "read",
					argsDigest: "r",
					timestamp: at(1),
					resultChars: 70,
				}),
			]);

			const [repeat] = await store.repeatedCalls();
			expect(repeat).toMatchObject({
				repeated: 1,
				rework: 1,
				reworkChars: 70,
				appraisal: 0,
				appraisalChars: 0,
			});
			await store.close();
		});

		it("calls a repeat after a verifier ran appraisal", async () => {
			const store = await openTurnStore(":memory:");
			await store.recordCalls([
				call({ digest: "c1", name: "read", argsDigest: "r", timestamp: at(0) }),
				call({
					digest: "v1",
					argsDigest: "npm test",
					verifierKind: "test",
					timestamp: at(1),
				}),
				call({
					digest: "c2",
					name: "read",
					argsDigest: "r",
					timestamp: at(2),
					resultChars: 70,
				}),
			]);

			const repeats = await store.repeatedCalls({ retrieval: ["read"] });
			expect(repeats[0]).toMatchObject({
				repeated: 1,
				rework: 0,
				appraisal: 1,
				appraisalChars: 70,
			});
			await store.close();
		});

		it("calls running a verifier again appraisal in itself", async () => {
			const store = await openTurnStore(":memory:");
			await store.recordCalls([
				call({ digest: "v1", verifierKind: "test", timestamp: at(0) }),
				call({ digest: "v2", verifierKind: "test", timestamp: at(1) }),
			]);

			const [repeat] = await store.repeatedCalls();
			expect(repeat).toMatchObject({ repeated: 1, rework: 0, appraisal: 1 });
			await store.close();
		});

		it("does not let a verifier before the first ask excuse the repeat", async () => {
			const store = await openTurnStore(":memory:");
			await store.recordCalls([
				call({
					digest: "v1",
					argsDigest: "t",
					verifierKind: "test",
					timestamp: at(0),
				}),
				call({ digest: "c1", name: "read", argsDigest: "r", timestamp: at(1) }),
				call({ digest: "c2", name: "read", argsDigest: "r", timestamp: at(2) }),
			]);

			const repeats = await store.repeatedCalls({ retrieval: ["read"] });
			expect(repeats[0]).toMatchObject({ rework: 1, appraisal: 0 });
			await store.close();
		});

		it("judges each repeat against the ask just before it", async () => {
			// Three asks, a verifier between the second and third: the
			// second is rework, the third appraisal.
			const store = await openTurnStore(":memory:");
			await store.recordCalls([
				call({ digest: "c1", name: "read", argsDigest: "r", timestamp: at(0) }),
				call({ digest: "c2", name: "read", argsDigest: "r", timestamp: at(1) }),
				call({
					digest: "v1",
					argsDigest: "t",
					verifierKind: "lint",
					timestamp: at(2),
				}),
				call({ digest: "c3", name: "read", argsDigest: "r", timestamp: at(3) }),
			]);

			const repeats = await store.repeatedCalls({ retrieval: ["read"] });
			expect(repeats[0]).toMatchObject({
				repeated: 2,
				rework: 1,
				appraisal: 1,
			});
			await store.close();
		});
	});
});
