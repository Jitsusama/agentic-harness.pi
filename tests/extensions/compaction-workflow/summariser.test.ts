/**
 * The compaction summary is asked of the conversation the session
 * last sent, and anything that cannot be done cleanly goes back to
 * pi's own summariser with its reason recorded.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const { registerConversationSummary, SUMMARY_FALLBACK_ENTRY } = await import(
	"../../../extensions/compaction-workflow/summariser.ts"
);
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
	registerConversationSummary(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		let result: unknown;
		for (const h of handlers.get(name) ?? []) result = await h(event, ctx);
		return result;
	};
	return { fire, entries, events };
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
});
