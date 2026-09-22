import { describe, expect, it } from "vitest";
import { readTurns } from "../../../lib/ledger/index.js";

function user(id: string): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp: "2026-09-21T17:50:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "go" }] },
	});
}

function assistant(
	id: string,
	timestamp: string,
	calls: Array<{ id: string; name: string; args: unknown }> = [],
): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp,
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: { input: 1, output: 1, cost: { total: 0.1 } },
			content: calls.map((c) => ({
				type: "toolCall",
				id: c.id,
				name: c.name,
				arguments: c.args,
			})),
		},
	});
}

function compaction(
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

describe("dropped calls", () => {
	it("marks a call before the kept boundary as dropped by that compaction", () => {
		const scan = readTurns("s1", [
			assistant("a1", "2026-09-21T17:50:00.000Z", [
				{ id: "t1", name: "read", args: { path: "/x" } },
			]),
			user("u1"),
			assistant("a2", "2026-09-21T17:52:00.000Z", [
				{ id: "t2", name: "bash", args: { command: "pwd" } },
			]),
			compaction("c1", "2026-09-21T17:53:00.000Z", "a2"),
		]);

		expect(scan.dropped).toHaveLength(1);
		expect(scan.dropped[0].callDigest).toBe(scan.calls[0].digest);
		expect(scan.dropped[0].droppedAtEntryId).toBe("c1");
	});

	it("keeps a call at or after the boundary undropped", () => {
		const scan = readTurns("s1", [
			assistant("a1", "2026-09-21T17:50:00.000Z", [
				{ id: "t1", name: "read", args: { path: "/x" } },
			]),
			assistant("a2", "2026-09-21T17:52:00.000Z", [
				{ id: "t2", name: "bash", args: { command: "pwd" } },
			]),
			compaction("c1", "2026-09-21T17:53:00.000Z", "a2"),
		]);

		expect(scan.dropped).toHaveLength(1);
		expect(scan.dropped[0].callDigest).toBe(scan.calls[0].digest);
	});

	it("attributes each drop to the compaction whose boundary passed it", () => {
		// A call kept by the first compaction (because it made the very
		// entry that boundary names) can still be dropped by the second,
		// whose boundary moved further forward.
		const scan = readTurns("s1", [
			assistant("a1", "2026-09-21T17:50:00.000Z", [
				{ id: "t1", name: "read", args: { path: "/x" } },
			]),
			assistant("a2", "2026-09-21T17:51:00.000Z", [
				{ id: "t2", name: "bash", args: { command: "pwd" } },
			]),
			compaction("c1", "2026-09-21T17:52:00.000Z", "a2"),
			assistant("a3", "2026-09-21T17:53:00.000Z", [
				{ id: "t3", name: "bash", args: { command: "date" } },
			]),
			compaction("c2", "2026-09-21T17:54:00.000Z", "a3"),
		]);

		expect(scan.dropped).toHaveLength(2);
		const byDigest = new Map(scan.dropped.map((d) => [d.callDigest, d]));
		expect(byDigest.get(scan.calls[0].digest)?.droppedAtEntryId).toBe("c1");
		expect(byDigest.get(scan.calls[1].digest)?.droppedAtEntryId).toBe("c2");
		expect(byDigest.has(scan.calls[2].digest)).toBe(false);
	});

	it("drops nothing when a session never compacts", () => {
		const scan = readTurns("s1", [
			assistant("a1", "2026-09-21T17:50:00.000Z", [
				{ id: "t1", name: "read", args: { path: "/x" } },
			]),
		]);

		expect(scan.dropped).toEqual([]);
	});

	it("leaves a call whose entry cannot be found undropped, rather than guessing", () => {
		const scan = readTurns("s1", [
			assistant("a1", "2026-09-21T17:50:00.000Z", [
				{ id: "t1", name: "read", args: { path: "/x" } },
			]),
			compaction("c1", "2026-09-21T17:53:00.000Z", "missing-entry"),
		]);

		expect(scan.dropped).toEqual([]);
	});
});
