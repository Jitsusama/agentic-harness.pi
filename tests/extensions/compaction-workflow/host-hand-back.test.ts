/**
 * The host handing a compaction back to pi's own summariser, saying
 * why: when the request can't be used, when the reply can't be a
 * checkpoint, after a retry, or when the window has no room left.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const {
	activate,
	compactEvent,
	context,
	fellBack,
	model,
	replyEntry,
	sentPayload,
	userEntry,
} = await import("./host-fixtures.ts");

describe("the conversation summariser", () => {
	beforeEach(() => {
		completeSimple.mockReset();
	});
	it("hands back to pi when the last request overflowed the window", async () => {
		const { fire, entries } = activate();
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const result = await fire(
			"session_before_compact",
			{ ...compactEvent(), reason: "overflow" },
			ctx,
		);
		expect(result).toBeUndefined();
		expect(entries).toEqual([
			fellBack("declined", "the last request overflowed the context window"),
		]);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("hands back to pi, saying why, when nothing was sent this session", async () => {
		const { fire, entries } = activate();
		const result = await fire(
			"session_before_compact",
			compactEvent(),
			context([userEntry, replyEntry]),
		);
		expect(result).toBeUndefined();
		expect(entries).toEqual([
			fellBack("declined", "nothing has been sent this session"),
		]);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("hands back to pi when the session has moved past the sent request", async () => {
		const { fire, entries } = activate();
		const ctx = context([userEntry, replyEntry, userEntry], "a1");
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		expect(
			await fire("session_before_compact", compactEvent(), ctx),
		).toBeUndefined();
		expect(entries[0]?.[1]).toMatchObject({
			reason: "the session moved on from the last request",
		});
	});

	it("hands back to pi when the reply cannot be a checkpoint", async () => {
		const { fire, entries } = activate();
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		completeSimple.mockResolvedValue({
			stopReason: "toolUse",
			content: [{ type: "toolCall", name: "read" }],
			usage: {},
		});
		expect(
			await fire("session_before_compact", compactEvent(), ctx),
		).toBeUndefined();
		expect(entries).toEqual([
			fellBack("failed", "the summariser called a tool"),
		]);
	});

	describe("asking again after a failure that could pass", () => {
		const dropped = {
			stopReason: "error",
			errorMessage: "Anthropic stream ended before message_stop",
			content: [],
			usage: {},
		};

		it("writes the summary on the second try, recording the first", async () => {
			const { fire, entries } = activate();
			const ctx = context([userEntry, replyEntry]);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			completeSimple.mockResolvedValueOnce(dropped).mockResolvedValueOnce({
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			});
			const result = (await fire(
				"session_before_compact",
				compactEvent(),
				ctx,
			)) as { compaction: { details: Record<string, unknown> } };

			expect(completeSimple).toHaveBeenCalledTimes(2);
			expect(result.compaction.details.attempts).toEqual([
				{
					provider: "conversation",
					timing: "on the spot",
					outcome: "retried",
					reason: dropped.errorMessage,
				},
			]);
			expect(entries).toEqual([]);
		});

		it("asks only once more before handing back to pi", async () => {
			const { fire, entries } = activate();
			const ctx = context([userEntry, replyEntry]);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			completeSimple.mockResolvedValue(dropped);
			await fire("session_before_compact", compactEvent(), ctx);

			expect(completeSimple).toHaveBeenCalledTimes(2);
			expect(entries[0]?.[1]).toMatchObject({
				attempts: [{ outcome: "retried" }, { outcome: "failed" }],
			});
		});

		it("does not ask again after a failure the same call would repeat", async () => {
			const { fire } = activate();
			const ctx = context([userEntry, replyEntry]);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			completeSimple.mockResolvedValue({
				...dropped,
				errorMessage: "invalid x-api-key",
			});
			await fire("session_before_compact", compactEvent(), ctx);
			expect(completeSimple).toHaveBeenCalledTimes(1);
		});
	});

	describe("leaving the summary room in the window", () => {
		const windowed = (contextWindow: number) => {
			const ctx = context([userEntry, replyEntry]);
			return { ...ctx, model: { ...model, contextWindow } };
		};

		it("hands back to pi when too little of the window is left", async () => {
			const { fire, entries } = activate();
			const ctx = windowed(310_000);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			await fire("session_before_compact", compactEvent(), ctx);
			expect(entries).toEqual([
				fellBack(
					"declined",
					"too little of the window is left to write the summary",
				),
			]);
			expect(completeSimple).not.toHaveBeenCalled();
		});

		it("asks for no more output than the window has room for", async () => {
			const { fire } = activate();
			const ctx = windowed(340_000);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			completeSimple.mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			});
			await fire("session_before_compact", compactEvent(), ctx);
			expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({
				maxTokens: 36_000,
			});
		});
	});
});
