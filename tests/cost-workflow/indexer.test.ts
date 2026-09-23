import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTurnStore } from "@jitsusama/agentic-harness.core/observability";
import { afterEach, describe, expect, it } from "vitest";
import { indexSessionLogs } from "../../extensions/cost-workflow/indexer.ts";

let scratch: string | null = null;

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = null;
});

function assistantLine(
	id: string,
	callId: string,
	timestamp = "2026-09-21T17:55:00.000Z",
): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp,
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: { input: 1, output: 1, cost: { total: 0.1 } },
			content: [
				{
					type: "toolCall",
					id: callId,
					name: "bash",
					arguments: { command: "ls" },
				},
			],
		},
	});
}

function compactionLine(
	id: string,
	timestamp: string,
	firstKeptEntryId: string,
): string {
	return JSON.stringify({
		id,
		type: "compaction",
		timestamp,
		firstKeptEntryId,
		tokensBefore: 400_000,
		usage: { input: 1, output: 1, cost: { total: 0.05 } },
	});
}

describe("indexing tool calls", () => {
	it("records calls alongside turns, and reports how many were new", async () => {
		scratch = mkdtempSync(join(tmpdir(), "ledger-indexer-"));
		const sessionsRoot = join(scratch, "sessions", "proj");
		mkdirSync(sessionsRoot, { recursive: true });
		writeFileSync(
			join(sessionsRoot, "one.jsonl"),
			`${[assistantLine("a1", "t1"), assistantLine("a2", "t2")].join("\n")}\n`,
			"utf8",
		);

		const store = await openTurnStore(join(scratch, "ledger.db"));
		const outcome = await indexSessionLogs(
			store,
			join(scratch, "watermarks.json"),
			join(scratch, "sessions"),
		);

		expect(outcome.insertedCalls).toBe(2);
		expect(outcome.duplicateCalls).toBe(0);
		expect(await store.queryCalls()).toHaveLength(2);
		await store.close();
	});

	it("records what a compaction dropped", async () => {
		scratch = mkdtempSync(join(tmpdir(), "ledger-indexer-"));
		const sessionsRoot = join(scratch, "sessions", "proj");
		mkdirSync(sessionsRoot, { recursive: true });
		writeFileSync(
			join(sessionsRoot, "one.jsonl"),
			`${[
				assistantLine("a1", "t1", "2026-09-21T17:50:00.000Z"),
				assistantLine("a2", "t2", "2026-09-21T17:51:00.000Z"),
				compactionLine("c1", "2026-09-21T17:52:00.000Z", "a2"),
			].join("\n")}\n`,
			"utf8",
		);

		const store = await openTurnStore(join(scratch, "ledger.db"));
		const outcome = await indexSessionLogs(
			store,
			join(scratch, "watermarks.json"),
			join(scratch, "sessions"),
		);

		expect(outcome.insertedDropped).toBe(1);
		expect(await store.queryDropped()).toHaveLength(1);
		await store.close();
	});

	it("does not re-record calls from a log that has not grown", async () => {
		scratch = mkdtempSync(join(tmpdir(), "ledger-indexer-"));
		const sessionsRoot = join(scratch, "sessions", "proj");
		mkdirSync(sessionsRoot, { recursive: true });
		const path = join(sessionsRoot, "one.jsonl");
		writeFileSync(path, `${assistantLine("a1", "t1")}\n`, "utf8");

		const store = await openTurnStore(join(scratch, "ledger.db"));
		const watermarks = join(scratch, "watermarks.json");
		await indexSessionLogs(store, watermarks, join(scratch, "sessions"));
		const second = await indexSessionLogs(
			store,
			watermarks,
			join(scratch, "sessions"),
		);

		expect(second.skipped).toBe(1);
		expect(second.insertedCalls).toBe(0);
		await store.close();
	});

	it("re-reads a log whose watermark predates what the scan now extracts", async () => {
		// The real failure: every log indexed before tool calls were
		// recorded kept its old size watermark, so it was skipped forever
		// and the live ledger held turns but not a single call.
		scratch = mkdtempSync(join(tmpdir(), "ledger-indexer-"));
		const sessionsRoot = join(scratch, "sessions", "proj");
		mkdirSync(sessionsRoot, { recursive: true });
		const path = join(sessionsRoot, "one.jsonl");
		const body = `${assistantLine("a1", "t1")}\n`;
		writeFileSync(path, body, "utf8");
		const watermarks = join(scratch, "watermarks.json");
		// The format every existing watermark file is in: a bare map of
		// path to size, with nothing saying what was extracted.
		writeFileSync(
			watermarks,
			JSON.stringify({ [path]: Buffer.byteLength(body) }),
			"utf8",
		);

		const store = await openTurnStore(join(scratch, "ledger.db"));
		const outcome = await indexSessionLogs(
			store,
			watermarks,
			join(scratch, "sessions"),
		);

		expect(outcome.skipped).toBe(0);
		expect(outcome.insertedCalls).toBe(1);
		await store.close();
	});

	it("skips an unchanged log once it has been read at the current scan version", async () => {
		scratch = mkdtempSync(join(tmpdir(), "ledger-indexer-"));
		const sessionsRoot = join(scratch, "sessions", "proj");
		mkdirSync(sessionsRoot, { recursive: true });
		writeFileSync(
			join(sessionsRoot, "one.jsonl"),
			`${assistantLine("a1", "t1")}\n`,
			"utf8",
		);
		const watermarks = join(scratch, "watermarks.json");
		const store = await openTurnStore(join(scratch, "ledger.db"));
		await indexSessionLogs(store, watermarks, join(scratch, "sessions"));

		const second = await indexSessionLogs(
			store,
			watermarks,
			join(scratch, "sessions"),
		);

		expect(second.skipped).toBe(1);
		await store.close();
	});
});
