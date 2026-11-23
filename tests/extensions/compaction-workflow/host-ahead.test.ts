/**
 * The host writing a summary ahead of the compaction that will want it:
 * when one is written, waited for, kept, discarded as outgrown, or
 * dropped, and what a failure ahead leaves behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const {
	activate,
	asContext,
	compactEvent,
	context,
	replyEntry,
	sentPayload,
	settle,
	userEntry,
} = await import("./host-fixtures.ts");
const { AHEAD_UNUSED_ENTRY, SUMMARY_WALL_MS } = await import(
	"../../../extensions/compaction-workflow/host.ts"
);
const { SUMMARY_CONTRIBUTIONS } = await import(
	"../../../lib/compaction/index.ts"
);

describe("the conversation summariser", () => {
	beforeEach(() => {
		completeSimple.mockReset();
	});
	describe("writing the summary ahead of the compaction", () => {
		const secondUser = {
			type: "message",
			id: "u2",
			message: {
				role: "user",
				content: [{ type: "text", text: "more" }],
				timestamp: 3,
			},
		};
		const secondReply = { ...replyEntry, id: "a2" };
		const reply = (text: string) => ({
			stopReason: "stop",
			content: [{ type: "text", text }],
			usage: { output: 900 },
		});

		async function writtenAhead() {
			const handle = activate();
			await handle.fire(
				"before_provider_request",
				{ payload: sentPayload },
				context([userEntry], "u1"),
			);
			return handle;
		}

		it("compacts at once with a summary written ahead, keeping everything after the point it covers", async () => {
			const { fire, summary, entries } = await writtenAhead();
			completeSimple.mockResolvedValue(reply("## Goal\nahead"));
			expect(
				summary.prepare(asContext(context([userEntry, replyEntry], "a1"))),
			).toEqual({ ok: true });
			await settle();
			expect(summary.state()).toBe("ready");

			// Work went on: pi would cut at a2, which would drop u2 unseen.
			const event = compactEvent();
			event.preparation.firstKeptEntryId = "a2";
			const result = (await fire(
				"session_before_compact",
				event,
				context([userEntry, replyEntry, secondUser, secondReply], "a2"),
			)) as { compaction: Record<string, unknown> };

			expect(result.compaction.firstKeptEntryId).toBe("u2");
			expect(result.compaction.summary).toContain("## Goal\nahead");
			expect(result.compaction.details).toMatchObject({
				summariser: "conversation",
				written: "ahead",
			});
			expect(completeSimple).toHaveBeenCalledTimes(1);
			expect(summary.state()).toBe("none");
			expect(entries).toEqual([]);
		});

		it("waits for a summary still being written rather than writing a second", async () => {
			const { fire, summary } = await writtenAhead();
			let finish: (value: unknown) => void = () => {};
			completeSimple.mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			expect(summary.state()).toBe("writing");

			const compacting = fire(
				"session_before_compact",
				compactEvent(),
				context([userEntry, replyEntry], "a1"),
			);
			await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
			finish(reply("## Goal\nawaited"));
			const result = (await compacting) as { compaction: { summary: string } };

			expect(result.compaction.summary).toContain("awaited");
			expect(completeSimple).toHaveBeenCalledTimes(1);
		});

		it("refuses to write ahead when nothing has been sent, saying why", () => {
			const { summary } = activate();
			expect(
				summary.prepare(asContext(context([userEntry, replyEntry], "a1"))),
			).toEqual({
				ok: false,
				reason: "nothing has been sent this session",
			});
			expect(completeSimple).not.toHaveBeenCalled();
		});

		it("records a summary that could not be written ahead and hands the failure over once", async () => {
			const { fire, summary, entries, outcomes } = await writtenAhead();
			completeSimple.mockResolvedValueOnce({
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: "read" }],
				usage: {},
			});
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await settle();

			expect(summary.state()).toBe("failed");
			expect(summary.takeFailure()).toBe("the summariser called a tool");
			expect(summary.state()).toBe("none");
			expect(entries).toEqual([
				[
					AHEAD_UNUSED_ENTRY,
					{ reason: "the summariser called a tool", tries: 1, halved: false },
				],
			]);
			expect(outcomes).toEqual([
				{
					kind: "ahead-unused",
					sessionId: "s1",
					reason: "the summariser called a tool",
				},
			]);

			// The compaction that follows writes its own, on the spot.
			completeSimple.mockResolvedValueOnce(reply("## Goal\nnow"));
			const result = (await fire(
				"session_before_compact",
				compactEvent(),
				context([userEntry, replyEntry], "a1"),
			)) as { compaction: { details: Record<string, unknown> } };
			expect(result.compaction.details).toMatchObject({
				written: "on the spot",
			});
		});

		it("asks contributors for focus when writing ahead and for the appendix when compacting", async () => {
			const { fire, summary, events } = await writtenAhead();
			const seen: Array<{ handled: boolean }> = [];
			events.on(SUMMARY_CONTRIBUTIONS, (data) => {
				const c = data as {
					instructions: string[];
					appendix: string[];
					handled: boolean;
				};
				c.instructions.push("keep the mastery layer");
				c.appendix.push("\n\n## Mastery\nlayer 2");
				seen.push(c);
			});
			let closing = "";
			completeSimple.mockImplementation(async (_m, c) => {
				closing = JSON.stringify(c.messages.at(-1));
				return reply("## Goal");
			});
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await settle();
			const result = (await fire(
				"session_before_compact",
				compactEvent(),
				context([userEntry, replyEntry], "a1"),
			)) as { compaction: { summary: string } };

			expect(closing).toContain("Additional focus: keep the mastery layer");
			expect(result.compaction.summary).toMatch(/## Mastery\nlayer 2$/);
			expect(result.compaction.summary.split("## Mastery")).toHaveLength(2);
			expect(seen.map((c) => c.handled)).toEqual([false, true]);
		});

		// 9 November: two summaries written ahead at about 180k were applied
		// nine hours later at 725k and 740k, and kept everything since,
		// 510k and 616k, which every turn after read again.
		it("discards a summary the conversation has far outgrown, and writes one on the spot", async () => {
			const { fire, summary, entries } = await writtenAhead();
			completeSimple.mockResolvedValue(reply("## Goal"));
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await settle();

			const event = compactEvent();
			event.preparation.tokensBefore = 700_000;
			const result = (await fire(
				"session_before_compact",
				event,
				context([userEntry, replyEntry], "a1"),
			)) as { compaction: { details: Record<string, unknown> } };

			expect(entries[0]).toEqual([
				AHEAD_UNUSED_ENTRY,
				{
					reason:
						"the conversation grew from 300,000 to 700,000 tokens since it was written",
				},
			]);
			expect(result.compaction.details).toMatchObject({
				written: "on the spot",
			});
			expect(completeSimple).toHaveBeenCalledTimes(2);
		});

		it("still applies a summary the conversation grew a little past", async () => {
			const { fire, summary, entries } = await writtenAhead();
			completeSimple.mockResolvedValue(reply("## Goal"));
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await settle();

			const event = compactEvent();
			event.preparation.tokensBefore = 330_000;
			const result = (await fire(
				"session_before_compact",
				event,
				context([userEntry, replyEntry], "a1"),
			)) as { compaction: { details: Record<string, unknown> } };

			expect(result.compaction.details).toMatchObject({ written: "ahead" });
			expect(entries).toEqual([]);
		});

		it("discards a summary of a point the branch has left, and writes one on the spot", async () => {
			const { fire, summary, entries } = await writtenAhead();
			completeSimple.mockResolvedValue(reply("## Goal"));
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await settle();

			const elsewhere = [userEntry, { ...replyEntry, id: "b1" }];
			await fire(
				"session_before_compact",
				compactEvent(),
				context(elsewhere, "b1"),
			);

			expect(entries[0]).toEqual([
				AHEAD_UNUSED_ENTRY,
				{ reason: "the summarised point is not on this branch" },
			]);
			expect(completeSimple).toHaveBeenCalledTimes(2);
		});

		it("records a summary whose credentials could not be read, rather than letting the failure escape", async () => {
			const { summary, entries } = await writtenAhead();
			const ctx = context([userEntry, replyEntry], "a1");
			ctx.modelRegistry.getApiKeyAndHeaders = async () => {
				throw new Error("the keychain is locked");
			};
			summary.prepare(asContext(ctx));
			await settle();

			expect(summary.state()).toBe("failed");
			expect(entries).toEqual([
				[
					AHEAD_UNUSED_ENTRY,
					{ reason: "the keychain is locked", tries: 1, halved: false },
				],
			]);
		});

		it("lets a compaction go on when the summary it waited for fails that way", async () => {
			const { fire, summary } = await writtenAhead();
			const ctx = context([userEntry, replyEntry], "a1");
			let fail: (error: Error) => void = () => {};
			ctx.modelRegistry.getApiKeyAndHeaders = () =>
				new Promise<never>((_resolve, reject) => {
					fail = reject;
				});
			summary.prepare(asContext(ctx));

			let settled = false;
			const compacting = Promise.resolve(
				fire("session_before_compact", compactEvent(), ctx),
			).finally(() => {
				settled = true;
			});
			await settle();
			fail(new Error("the keychain is locked"));
			await settle();
			fail(new Error("the keychain is locked"));
			await settle();

			expect(
				settled,
				"compacting ends once the key lookup fails, however often it fails",
			).toBe(true);
			await compacting;
		});

		it("gives up on a summary the model never finishes, once its clock runs out", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const { summary, entries } = await writtenAhead();
				let handed: AbortSignal | undefined;
				// Like the real call, it ends only when its signal says so.
				completeSimple.mockImplementation(
					(_m, _c, options: { signal: AbortSignal }) =>
						new Promise((resolve) => {
							handed = options.signal;
							options.signal.addEventListener("abort", () =>
								resolve({ stopReason: "aborted", content: [], usage: {} }),
							);
						}),
				);
				summary.prepare(asContext(context([userEntry, replyEntry], "a1")));

				await vi.advanceTimersByTimeAsync(SUMMARY_WALL_MS + 1000);

				expect(
					handed?.aborted,
					"the summary call's signal is stopped once its clock runs out",
				).toBe(true);
				expect(summary.state()).toBe("failed");
				expect(entries).toEqual([
					[
						AHEAD_UNUSED_ENTRY,
						{
							reason: "the summary was not written within 12 minutes",
							tries: 1,
							halved: false,
						},
					],
				]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("tells every listener a summary is ready, even after one of them throws", async () => {
			const { summary } = await writtenAhead();
			completeSimple.mockResolvedValue(reply("## Goal"));
			const told: string[] = [];
			summary.whenReady(() => {
				throw new Error("a listener broke");
			});
			summary.whenReady(() => told.push("second"));
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await settle();

			expect(summary.state()).toBe("ready");
			expect(told).toEqual(["second"]);
		});

		it("drops a summary being written when the session starts over", async () => {
			const { fire, summary } = await writtenAhead();
			completeSimple.mockImplementation(() => new Promise(() => {}));
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await fire("session_start", { reason: "new" }, context([], null));
			expect(summary.state()).toBe("none");
		});
	});
});
