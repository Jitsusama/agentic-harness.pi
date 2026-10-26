import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DroppedCallRecord,
	openTurnStore,
	type ToolCallRecord,
	type TurnRecord,
} from "../../../../lib/core/observability/ledger/index.ts";

function turn(digest: string): TurnRecord {
	return {
		entryId: `e-${digest}`,
		sessionId: "s1",
		timestamp: "2026-09-30T12:00:00.000Z",
		kind: "assistant",
		model: "claude-opus-5-5",
		thinkingLevel: null,
		tokens: {
			input: 1,
			output: 10,
			cacheRead: 100,
			cacheWrite: 20,
			total: 131,
		},
		cost: {
			input: 0,
			output: 0.1,
			cacheRead: 0.01,
			cacheWrite: 0.02,
			total: 0.13,
		},
		cacheWrite1h: 20,
		droppedBefore: null,
		firstKeptEntryId: null,
		digest,
	};
}

function call(digest: string): ToolCallRecord {
	return {
		digest,
		sessionId: "s1",
		entryId: "a1",
		callId: `t-${digest}`,
		timestamp: "2026-09-30T12:00:00.000Z",
		name: "bash",
		argsDigest: `args-${digest}`,
		path: null,
		resultChars: 100,
		resultDigest: `res-${digest}`,
		isError: false,
		verifierKind: null,
	};
}

function dropped(callDigest: string): DroppedCallRecord {
	return {
		callDigest,
		sessionId: "s1",
		droppedAtEntryId: "comp1",
		droppedAtTimestamp: "2026-09-30T12:05:00.000Z",
	};
}

const BATCH = 200;

function digests(prefix: string): string[] {
	return Array.from({ length: BATCH }, (_, i) => `${prefix}${i}`);
}

/**
 * Two pi sessions index the same logs into one ledger file at once. Each
 * asks the table what it already holds before either has committed, so
 * both believe every record is new. The second writer must then find its
 * rows already there and carry on, not fail the pass.
 */
describe("two stores indexing one ledger at once", () => {
	async function twoStores() {
		const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.db");
		return [await openTurnStore(path), await openTurnStore(path)] as const;
	}

	it("records each tool call once and fails neither pass", async () => {
		const [a, b] = await twoStores();
		const calls = digests("c").map(call);

		const [first, second] = await Promise.all([
			a.recordCalls(calls),
			b.recordCalls(calls),
		]);

		expect(first.inserted + second.inserted).toBe(BATCH);
		expect(await a.queryCalls()).toHaveLength(BATCH);
		await a.close();
		await b.close();
	});

	it("records each dropped call once and fails neither pass", async () => {
		const [a, b] = await twoStores();
		const records = digests("c").map(dropped);

		const [first, second] = await Promise.all([
			a.recordDropped(records),
			b.recordDropped(records),
		]);

		expect(first.inserted + second.inserted).toBe(BATCH);
		expect(await a.queryDropped()).toHaveLength(BATCH);
		await a.close();
		await b.close();
	});

	it("counts each turn as inserted by exactly one pass", async () => {
		const [a, b] = await twoStores();
		const turns = digests("t").map(turn);

		const [first, second] = await Promise.all([
			a.recordTurns(turns),
			b.recordTurns(turns),
		]);

		expect(first.inserted + second.inserted).toBe(BATCH);
		expect((await a.total()).turns).toBe(BATCH);
		await a.close();
		await b.close();
	});
});
