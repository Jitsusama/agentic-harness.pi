import { describe, expect, it } from "vitest";
import { readTurns, repoOf } from "../../../lib/ledger/index.ts";

function assistantLine(id: string, timestamp: string): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp,
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: { input: 1, output: 1, cost: { total: 0.5 } },
		},
	});
}

function questLine(cwd: string | null, questId: string | null): string {
	return JSON.stringify({
		id: "q1",
		type: "custom",
		customType: "quest-workflow",
		timestamp: "2026-09-21T17:00:00.000Z",
		data: { questId, documentPath: null, cwd, verify: null },
	});
}

describe("repoOf", () => {
	it("names a repo by its host, owner and name", () => {
		expect(repoOf("/Users/j/src/github.com/Shopify/world")).toBe(
			"github.com/Shopify/world",
		);
		expect(repoOf("/Users/j/src/gitlab.com/jitsusama/designs/sub/dir")).toBe(
			"gitlab.com/jitsusama/designs",
		);
	});

	it("names a monorepo zone rather than the tree it was cut into", () => {
		// Two worktrees of the same zone are the same subject. Naming the
		// tree would split one zone's spend across every tree ever cut.
		expect(repoOf("/Users/j/world/trees/root/src/system/gitstream")).toBe(
			"world/system/gitstream",
		);
		expect(
			repoOf("/Users/j/world/trees/pi-pr-workflow-8d7f/src/system/gitstream"),
		).toBe("world/system/gitstream");
	});

	it("gives back nothing when the path names no repo", () => {
		expect(repoOf(null)).toBeNull();
		expect(repoOf("/Users/j")).toBeNull();
	});
});

function headerLine(cwd: string): string {
	return JSON.stringify({
		type: "session",
		id: "019fe2c6-b46e-704a-b8c7-d6b7b0c015b4",
		timestamp: "2026-09-21T16:00:00.000Z",
		cwd,
	});
}

describe("readTurns session attribution", () => {
	it("takes the directory from the header every log carries", () => {
		// Only a quarter of logs hold a quest entry, but every one opens
		// with a session header naming its cwd. Depending on the former
		// left 42 percent of spend unattributed to any repo.
		const scan = readTurns("s1", [
			headerLine("/Users/j/world/trees/root/src/system/gitstream"),
			assistantLine("a1", "2026-09-21T17:10:00.000Z"),
		]);

		expect(scan.session.cwd).toBe(
			"/Users/j/world/trees/root/src/system/gitstream",
		);
		expect(scan.session.repo).toBe("world/system/gitstream");
		expect(scan.session.quest).toBeNull();
	});

	it("reports the directory and quest the log names", () => {
		const scan = readTurns("s1", [
			questLine("/Users/j/src/github.com/Shopify/world", "QEST-1"),
			assistantLine("a1", "2026-09-21T17:10:00.000Z"),
		]);

		expect(scan.session.sessionId).toBe("s1");
		expect(scan.session.cwd).toBe("/Users/j/src/github.com/Shopify/world");
		expect(scan.session.repo).toBe("github.com/Shopify/world");
		expect(scan.session.quest).toBe("QEST-1");
	});

	it("spans the first and last turn it billed", () => {
		const scan = readTurns("s1", [
			assistantLine("a1", "2026-09-21T10:00:00.000Z"),
			assistantLine("a2", "2026-09-21T12:00:00.000Z"),
			assistantLine("a3", "2026-09-21T11:00:00.000Z"),
		]);

		expect(scan.session.firstSeen).toBe("2026-09-21T10:00:00.000Z");
		expect(scan.session.lastSeen).toBe("2026-09-21T12:00:00.000Z");
	});

	it("keeps the last quest a log names, since a session can move", () => {
		const scan = readTurns("s1", [
			questLine("/Users/j/src/github.com/Shopify/world", "QEST-1"),
			assistantLine("a1", "2026-09-21T10:00:00.000Z"),
			questLine("/Users/j/src/github.com/Shopify/world", "QEST-2"),
		]);

		expect(scan.session.quest).toBe("QEST-2");
	});

	it("holds nothing rather than guessing when the log never says", () => {
		// Most sessions carry no quest entry at all. An absent attribution
		// has to stay absent: inferring one would put spend against work
		// that did not incur it.
		const scan = readTurns("s1", [
			questLine(null, null),
			assistantLine("a1", "2026-09-21T10:00:00.000Z"),
		]);

		expect(scan.session.cwd).toBeNull();
		expect(scan.session.repo).toBeNull();
		expect(scan.session.quest).toBeNull();
	});
});
