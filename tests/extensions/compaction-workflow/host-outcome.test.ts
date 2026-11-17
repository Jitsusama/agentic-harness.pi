/**
 * The host saying what became of a compaction: done once pi applied
 * it, why pi's summariser wrote it instead, and what each contributor
 * did, kept on the compaction entry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const { activate, compactEvent, context, replyEntry, sentPayload, userEntry } = await import(
	"./host-fixtures.ts"
);
const { recordContribution, SUMMARY_CONTRIBUTIONS } = await import(
	"../../../lib/compaction/index.ts"
);

describe("the conversation summariser", () => {
	beforeEach(() => {
		completeSimple.mockReset();
	});
	describe("saying what became of the compaction", () => {
		it("says a compaction was done once pi has applied it", async () => {
			const { fire, outcomes } = activate();
			const ctx = context([userEntry, replyEntry]);
			const compactionEntry = {
				tokensBefore: 300_000,
				firstKeptEntryId: "u1",
				details: { summariser: "conversation" },
			};
			await fire("session_compact", { compactionEntry }, ctx);
			expect(outcomes).toEqual([
				{
					kind: "compacted",
					sessionId: "s1",
					tokensBefore: 300_000,
					firstKeptEntryId: "u1",
					details: { summariser: "conversation" },
				},
			]);
		});

		it("says why pi's summariser is writing it instead", async () => {
			const { fire, outcomes } = activate();
			await fire(
				"session_before_compact",
				compactEvent(),
				context([userEntry, replyEntry]),
			);
			expect(outcomes).toEqual([
				{
					kind: "fallback",
					sessionId: "s1",
					reason: "nothing has been sent this session",
					attempts: [
						{
							provider: "conversation",
							timing: "on the spot",
							outcome: "declined",
							reason: "nothing has been sent this session",
						},
					],
				},
			]);
		});

		it("keeps what each contributor did on the compaction entry", async () => {
			const { fire, events } = activate();
			events.on(SUMMARY_CONTRIBUTIONS, (data) =>
				recordContribution(
					data as Parameters<typeof recordContribution>[0],
					"selection",
					{ chosen: 0, unavailable: "no classifier" },
				),
			);
			const ctx = context([userEntry, replyEntry]);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			completeSimple.mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			});
			const result = (await fire(
				"session_before_compact",
				compactEvent(),
				ctx,
			)) as { compaction: { details: Record<string, unknown> } };
			expect(result.compaction.details.contributions).toEqual({
				selection: { chosen: 0, unavailable: "no classifier" },
			});
		});
	});
});
