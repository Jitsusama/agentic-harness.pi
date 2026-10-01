import { describe, expect, it } from "vitest";
import {
	describeOutcome,
	type WorkflowFacts,
	workflowSection,
} from "../../../extensions/compaction-workflow/status.ts";

const FACTS: WorkflowFacts = {
	enabled: true,
	floorTokens: 0,
	retention: "long",
	chain: { providers: ["conversation", "pi"], unknown: [] },
	ahead: "none",
};

describe("the workflow's status", () => {
	it("says what it would do now, and that the branch has not compacted", () => {
		expect(workflowSection(FACTS, []).lines).toEqual([
			"trigger: on",
			"provider chain: conversation, then pi",
			"cache retention: long",
			"summary written ahead: none",
			"last outcome in this process: none since load",
			"compactions on this branch: none yet",
		]);
	});

	it("names a configured provider nothing registered, and a short cache", () => {
		const lines = workflowSection(
			{
				...FACTS,
				enabled: false,
				floorTokens: 100_000,
				retention: undefined,
				chain: { providers: ["pi"], unknown: ["jev"] },
			},
			[],
		).lines;

		expect(lines).toContain(
			"trigger: off (PI_COMPACTION_POLICY=off), never at or below 100k",
		);
		expect(lines).toContain("  configured but not registered: jev");
		expect(lines).toContain(
			"cache retention: default (idle compaction needs long)",
		);
	});

	it("reads the last compaction's records off the branch", () => {
		const branch = [
			{ type: "compaction", summary: "old" },
			{
				type: "compaction",
				summary: "new",
				tokensBefore: 241_000,
				timestamp: "2026-10-01T12:00:00.000Z",
				details: {
					summariser: "conversation",
					written: "ahead",
					contributions: { selection: {}, recall: {} },
				},
			},
		];

		expect(workflowSection(FACTS, branch).lines.slice(-4)).toEqual([
			"compactions on this branch: 2",
			"last compaction: at 2026-10-01T12:00:00.000Z from 241k",
			"  written by: conversation, ahead",
			"  contributions recorded: selection, recall",
		]);
	});

	it("says each kind of outcome in a line", () => {
		expect(
			describeOutcome({
				kind: "compacted",
				sessionId: "s",
				tokensBefore: 240_000,
				firstKeptEntryId: "e",
				details: { summariser: "conversation" },
			}),
		).toBe("compacted at 240k by conversation");
		expect(
			describeOutcome({
				kind: "fallback",
				sessionId: "s",
				reason: "the stream ended",
				attempts: [],
			}),
		).toBe("fell back to pi's summariser: the stream ended");
		expect(
			describeOutcome({
				kind: "failed",
				sessionId: "s",
				failure: {
					tokens: 300_000,
					error: "overloaded",
					consecutiveFailures: 1,
					retryAfterTurns: 8,
				},
			}),
		).toBe("failed at 300k: overloaded");
	});
});
