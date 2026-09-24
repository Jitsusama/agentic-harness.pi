/**
 * The compaction summary is asked of the conversation the session
 * last sent, and anything that cannot be done cleanly goes back to
 * pi's own summariser with its reason recorded.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const {
	AHEAD_UNUSED_ENTRY,
	registerConversationSummary,
	SUMMARY_FALLBACK_ENTRY,
} = await import("../../../extensions/compaction-workflow/summariser.ts");
const { SUMMARY_CONTRIBUTIONS, SUMMARY_SPAN } = await import(
	"../../../lib/compaction/index.ts"
);

type Handler = (event: unknown, ctx: unknown) => unknown;

function activate() {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<[string, unknown]> = [];
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const events = {
		on: (channel: string, h: (data: unknown) => void) =>
			listeners.set(channel, [...(listeners.get(channel) ?? []), h]),
		emit: (channel: string, data: unknown) => {
			for (const h of listeners.get(channel) ?? []) h(data);
		},
	};
	const pi = {
		events,
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: (type: string, data: unknown) => entries.push([type, data]),
	};
	const summary = registerConversationSummary(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		let result: unknown;
		for (const h of handlers.get(name) ?? []) result = await h(event, ctx);
		return result;
	};
	return { fire, entries, events, summary };
}

/** Let a summary being written in the background finish. */
async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const model = {
	id: "claude-opus-5-5",
	api: "anthropic-messages",
	provider: "anthropic",
	maxTokens: 128_000,
};

const userEntry = {
	type: "message",
	id: "u1",
	message: {
		role: "user",
		content: [{ type: "text", text: "go" }],
		timestamp: 1,
	},
};
const replyEntry = {
	type: "message",
	id: "a1",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {},
		stopReason: "stop",
		timestamp: 2,
	},
};

function context(branch: unknown[], leaf: string | null = "u1") {
	return {
		model,
		hasUI: false,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
		},
		sessionManager: {
			getLeafId: () => leaf,
			getBranch: () => branch,
			getSessionId: () => "s1",
		},
	};
}

/** The fake context, as the handle's API types it. */
function asContext(ctx: ReturnType<typeof context>): ExtensionContext {
	return ctx as unknown as ExtensionContext;
}

function compactEvent() {
	return {
		preparation: {
			firstKeptEntryId: "u1",
			tokensBefore: 300_000,
			previousSummary: undefined,
			fileOps: {
				read: new Set(["a.ts"]),
				edited: new Set(),
				written: new Set(),
			},
			settings: { reserveTokens: 64_000 },
		},
		customInstructions: undefined,
		signal: new AbortController().signal,
	};
}

const sentPayload = {
	model: "claude-opus-5-5",
	system: [{ type: "text", text: "SYSTEM" }],
	messages: [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		{ role: "system", content: [], output_config: { effort: "high" } },
	],
};

describe("the conversation summariser", () => {
	beforeEach(() => {
		completeSimple.mockReset();
	});

	it("summarises from the sent request and returns pi a checkpoint", async () => {
		const { fire, entries } = activate();
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		let sentToProvider: unknown;
		completeSimple.mockImplementation(async (_m, _c, options) => {
			sentToProvider = await options.onPayload({
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
					{ role: "user", content: [{ type: "text", text: "summarise" }] },
				],
			});
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal\nship it" }],
				usage: { input: 10, cacheRead: 290_000 },
			};
		});

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		)) as {
			compaction: Record<string, unknown>;
		};

		expect(result.compaction.summary).toBe(
			`${SUMMARY_SPAN}\n\n## Goal\nship it\n\n<read-files>\na.ts\n</read-files>`,
		);
		expect(result.compaction.firstKeptEntryId).toBe("u1");
		expect(result.compaction.usage).toEqual({ input: 10, cacheRead: 290_000 });
		expect(result.compaction.details).toMatchObject({
			summariser: "conversation",
		});
		expect(sentToProvider).toMatchObject({
			system: sentPayload.system,
			max_tokens: 51_200,
		});
		expect((sentToProvider as { messages: unknown[] }).messages).toHaveLength(
			4,
		);
		expect(entries).toEqual([]);
	});

	it("takes other extensions' focus and appendix, and tells them it wrote the summary", async () => {
		const { fire, events } = activate();
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
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		let closing = "";
		completeSimple.mockImplementation(async (_m, c) => {
			closing = JSON.stringify(c.messages.at(-1));
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			};
		});
		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		)) as {
			compaction: { summary: string };
		};
		expect(closing).toContain("Additional focus: keep the mastery layer");
		expect(result.compaction.summary).toBe(
			`${SUMMARY_SPAN}\n\n## Goal\n\n<read-files>\na.ts\n</read-files>\n\n## Mastery\nlayer 2`,
		);
		expect(seen[0]?.handled).toBe(true);
	});

	it("says a focus once when it arrives both by hand and as a contribution", async () => {
		const { fire, events } = activate();
		events.on(SUMMARY_CONTRIBUTIONS, (data) =>
			(data as { instructions: string[] }).instructions.push("keep the layer"),
		);
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		let closing = "";
		completeSimple.mockImplementation(async (_m, c) => {
			closing = JSON.stringify(c.messages.at(-1));
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			};
		});
		await fire(
			"session_before_compact",
			{ ...compactEvent(), customInstructions: "keep the layer" },
			ctx,
		);
		expect(closing.split("keep the layer")).toHaveLength(2);
	});

	it("asks for contributions even when it hands back to pi, leaving them unhandled", async () => {
		const { fire, events } = activate();
		const seen: Array<{ handled: boolean; preparation: object }> = [];
		events.on(SUMMARY_CONTRIBUTIONS, (data) =>
			seen.push(data as { handled: boolean; preparation: object }),
		);
		const event = compactEvent();
		await fire(
			"session_before_compact",
			event,
			context([userEntry, replyEntry]),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.handled).toBe(false);
		expect(seen[0]?.preparation).toBe(event.preparation);
	});

	it("keeps the last request across a reload of the same session", async () => {
		const before = activate();
		const ctx = context([userEntry, replyEntry]);
		await before.fire("before_provider_request", { payload: sentPayload }, ctx);
		await before.fire("session_shutdown", { reason: "reload" }, ctx);

		const after = activate();
		await after.fire("session_start", { reason: "reload" }, ctx);
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const result = await after.fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		);

		expect(after.entries).toEqual([]);
		expect(result).toHaveProperty("compaction");
	});

	it("does not carry a request across a reload into another session", async () => {
		const before = activate();
		const ctx = context([userEntry, replyEntry]);
		await before.fire("before_provider_request", { payload: sentPayload }, ctx);
		await before.fire("session_shutdown", { reason: "reload" }, ctx);

		const after = activate();
		const other = {
			...ctx,
			sessionManager: { ...ctx.sessionManager, getSessionId: () => "s2" },
		};
		await after.fire("session_start", { reason: "reload" }, other);
		await after.fire("session_before_compact", compactEvent(), other);

		expect(after.entries).toEqual([
			[
				SUMMARY_FALLBACK_ENTRY,
				{ reason: "nothing has been sent this session" },
			],
		]);
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
			[
				SUMMARY_FALLBACK_ENTRY,
				{ reason: "the last request overflowed the context window" },
			],
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
			[
				SUMMARY_FALLBACK_ENTRY,
				{ reason: "nothing has been sent this session" },
			],
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
		expect(entries[0]?.[1]).toEqual({
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
		expect(entries[0]?.[1]).toEqual({ reason: "the summariser called a tool" });
	});

	it.each([
		["short", undefined, 5 * 60_000],
		["long", "long", 60 * 60_000],
	])("hands back to pi once a %s-retention cache may have expired", async (_name, retention, lifetime) => {
		vi.useFakeTimers();
		vi.stubEnv("PI_CACHE_RETENTION", retention);
		try {
			const { fire, entries } = activate();
			const ctx = context([userEntry, replyEntry]);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			vi.advanceTimersByTime(lifetime);
			expect(
				await fire("session_before_compact", compactEvent(), ctx),
			).toBeUndefined();
			expect(entries[0]?.[1]).toEqual({
				reason: "the cached conversation may have expired",
			});
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
		}
	});

	it("forgets the sent request once the session compacts", async () => {
		const { fire, entries } = activate();
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		await fire("session_compact", {}, ctx);
		await fire("session_before_compact", compactEvent(), ctx);
		expect(entries[0]?.[1]).toEqual({
			reason: "nothing has been sent this session",
		});
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
			const { fire, summary, entries } = await writtenAhead();
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
				[AHEAD_UNUSED_ENTRY, { reason: "the summariser called a tool" }],
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
			expect(result.compaction.summary.endsWith("## Mastery\nlayer 2")).toBe(
				true,
			);
			expect(result.compaction.summary.split("## Mastery")).toHaveLength(2);
			expect(seen.map((c) => c.handled)).toEqual([false, true]);
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

		it("drops a summary being written when the session starts over", async () => {
			const { fire, summary } = await writtenAhead();
			completeSimple.mockImplementation(() => new Promise(() => {}));
			summary.prepare(asContext(context([userEntry, replyEntry], "a1")));
			await fire("session_start", { reason: "new" }, context([], null));
			expect(summary.state()).toBe("none");
		});
	});
});
