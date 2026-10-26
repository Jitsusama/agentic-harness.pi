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
		timestamp: "2026-09-21T17:50:00.000Z",
		name: "bash",
		argsDigest: "args-1",
		path: null,
		resultChars: 100,
		resultDigest: "res-1",
		isError: false,
		verifierKind: null,
		...overrides,
	};
}

describe("verifier outcomes", () => {
	it("round-trips a call's verifier kind", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([call({ verifierKind: "test" })]);

		const [row] = await store.queryCalls();
		expect(row.verifierKind).toBe("test");
		await store.close();
	});

	it("counts passed, failed and unknown per kind", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", verifierKind: "test", isError: false }),
			call({
				digest: "c2",
				callId: "t2",
				verifierKind: "test",
				isError: false,
			}),
			call({ digest: "c3", callId: "t3", verifierKind: "test", isError: true }),
			call({
				digest: "c4",
				callId: "t4",
				verifierKind: "test",
				isError: null,
				resultChars: null,
				resultDigest: null,
			}),
			call({
				digest: "c5",
				callId: "t5",
				verifierKind: "lint",
				isError: false,
			}),
		]);

		const outcomes = await store.verifierOutcomes();
		const test = outcomes.find((o) => o.kind === "test");
		expect(test).toEqual({ kind: "test", passed: 2, failed: 1, unknown: 1 });
		const lint = outcomes.find((o) => o.kind === "lint");
		expect(lint).toEqual({ kind: "lint", passed: 1, failed: 0, unknown: 0 });
		await store.close();
	});

	it("leaves out a kind that never ran rather than reporting it as zero", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([call({ verifierKind: "test" })]);

		const outcomes = await store.verifierOutcomes();
		expect(outcomes.some((o) => o.kind === "build")).toBe(false);
		await store.close();
	});

	it("does not count an ordinary call toward any kind", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([call({ verifierKind: null })]);

		expect(await store.verifierOutcomes()).toEqual([]);
		await store.close();
	});
});
