/**
 * What each system message declared or took away, tool by tool, so the
 * set a session holds at any turn is a plain fold from empty: pi sends
 * the first set whole and every later change as a delta.
 */
import { describe, expect, it } from "vitest";
import { openTurnStore } from "../../../lib/core/observability/ledger/index.ts";
import { readTurns } from "../../../lib/ledger/index.ts";

const BASH = { name: "bash", description: "Run a command", parameters: {} };
const SLACK = { name: "slack", description: "Read Slack", parameters: {} };
const SLACK_WIDER = {
	name: "slack",
	description: "Read and search Slack, threads included",
	parameters: {},
};

function system(
	id: string,
	at: string,
	change: { toolsAdded?: unknown[]; toolsRemoved?: unknown[] },
): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp: at,
		message: {
			role: "system",
			sections: { rules: "Be concise." },
			...change,
		},
	});
}

const LOG = [
	system("s1", "2026-11-12T08:00:00.000Z", { toolsAdded: [BASH, SLACK] }),
	system("s2", "2026-11-12T09:00:00.000Z", {
		toolsRemoved: [{ name: "slack" }],
	}),
	system("s3", "2026-11-12T10:00:00.000Z", { toolsAdded: [SLACK_WIDER] }),
];

describe("the tools each system message declared", () => {
	it("adds the first set, then each change, at its own size", () => {
		const scan = readTurns("log-1", LOG);
		expect(
			scan.declarations.map((d) => [d.entryId, d.tool, d.change, d.chars]),
			"bash and slack, slack taken away, slack back wider",
		).toEqual([
			["s1", "bash", "added", JSON.stringify(BASH).length],
			["s1", "slack", "added", JSON.stringify(SLACK).length],
			["s2", "slack", "removed", 0],
			["s3", "slack", "added", JSON.stringify(SLACK_WIDER).length],
		]);
	});

	it("keeps a tool taken away and added back in one message as added", () => {
		const scan = readTurns("log-1", [
			system("s1", "2026-11-12T08:00:00.000Z", {
				toolsRemoved: [{ name: "slack" }],
				toolsAdded: [SLACK_WIDER],
			}),
		]);
		expect(
			scan.declarations.map((d) => [d.tool, d.change]),
			"one row, the tool held",
		).toEqual([["slack", "added"]]);
	});

	it("is kept once however often a grown log is read again", async () => {
		const store = await openTurnStore(":memory:");
		const first = await store.recordDeclarations(
			readTurns("log-1", LOG).declarations,
		);
		const again = await store.recordDeclarations(
			readTurns("log-1", LOG).declarations,
		);
		const held = await store.queryDeclarations();
		await store.close();
		expect(
			[first.inserted, again.inserted, held.length, held.at(0)?.sessionId],
			"four rows, written once",
		).toEqual([4, 0, 4, "log-1"]);
	});
});
