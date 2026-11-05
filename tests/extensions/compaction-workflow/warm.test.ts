/**
 * Idle warming, through the workflow's events: an idle session's last
 * request goes out again with a one-token cap 54 minutes after it was
 * sent and every 54 minutes after, at most four times, and anything
 * real stops it. Fake timers stand in for the hours.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

/** The package config the workflow reads, which each test may set. */
let sections: Record<string, unknown> = {};
vi.mock("../../../lib/internal/config/loader.ts", async (original) => ({
	...(await original<object>()),
	loadPackageConfig: async () => ({
		ok: true,
		path: "config.json",
		config: { version: 1, sections },
	}),
}));

const { readTurns } = await import("../../../lib/ledger/index.ts");
const { default: compactionWorkflow } = await import(
	"../../../extensions/compaction-workflow/index.ts"
);

const MINUTE = 60_000;
const WARM_EVERY = 54 * MINUTE;

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A one-hour request, as pi builds it for Opus 5.5 with adaptive thinking. */
const payload = {
	model: "claude-opus-5-5",
	max_tokens: 128_000,
	stream: true,
	thinking: { type: "adaptive", display: "summarized" },
	system: [
		{
			type: "text",
			text: "You are pi.",
			cache_control: { type: "ephemeral", ttl: "1h" },
		},
	],
	messages: [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "go",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		},
	],
};

/** A warm's reply: the prompt read from cache, one token out. */
function warmReply(cacheWrite = 0) {
	return {
		role: "assistant",
		content: [],
		provider: "anthropic",
		model: "claude-opus-5-5",
		stopReason: "length",
		usage: {
			input: 3,
			output: 1,
			cacheRead: 188_000,
			cacheWrite,
			totalTokens: 188_004 + cacheWrite,
			cost: {
				input: 0.000012,
				output: 0.00002,
				cacheRead: 0.0376,
				cacheWrite: cacheWrite * 0.000008,
				total: 0.037632 + cacheWrite * 0.000008,
			},
		},
	};
}

function activate(appendFails = false) {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
	const pi = {
		events: { on: () => {}, emit: () => {} },
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: (type: string, data: Record<string, unknown>) => {
			if (appendFails) throw new Error("disk full");
			entries.push({ type, data });
		},
		registerCommand: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	compactionWorkflow(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { fire, entries };
}

function session() {
	const state = {
		idle: true,
		tokens: 20_000,
		replies: [] as unknown[],
		compactions: 0,
	};
	const sent: Array<{ options: Record<string, unknown>; body: unknown }> = [];
	const model = {
		id: "claude-opus-5-5",
		api: "anthropic-messages",
		provider: "anthropic",
		maxTokens: 128_000,
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	};
	const ctx = {
		mode: "tui",
		hasUI: false,
		model,
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: state.tokens }),
		compact: () => {
			state.compactions += 1;
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
			streamSimple: (
				_model: unknown,
				_context: unknown,
				options: Record<string, unknown> & { onPayload: () => unknown },
			) => {
				sent.push({ options, body: options.onPayload() });
				const reply = state.replies.shift() ?? warmReply();
				return { result: async () => reply };
			},
		},
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => [],
			getLeafId: () => "u1",
		},
	};
	return { state, sent, ctx };
}

/** One agent turn's request, then the run ending and settling. */
async function turn(
	fire: (name: string, event: unknown, ctx: unknown) => Promise<void>,
	ctx: unknown,
	body: unknown = payload,
) {
	await fire("agent_start", {}, ctx);
	await fire("context", { messages: [] }, ctx);
	await fire(
		"before_provider_headers",
		{ headers: { "pi-session-id": "s1" } },
		ctx,
	);
	await fire("before_provider_request", { payload: body }, ctx);
	await fire("agent_end", { messages: [] }, ctx);
	await fire("agent_settled", { aborted: false }, ctx);
}

/** Move the clock and let what the timers started finish. */
async function wait(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function idleSession() {
	const { fire, entries } = activate();
	const { state, sent, ctx } = session();
	await fire("session_start", { reason: "startup" }, ctx);
	await turn(fire, ctx);
	return { fire, entries, state, sent, ctx };
}

type Entry = { type: string; data: Record<string, unknown> };
const warms = (entries: Entry[]) =>
	entries.filter((e) => e.type === "compaction-cache-warm");
const stops = (entries: Entry[]) =>
	entries.filter((e) => e.type === "compaction-cache-warm-stopped");

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("PI_CACHE_RETENTION", "long");
	// Nothing here may write a session's request to the real state dir.
	vi.stubEnv("PI_COMPACTION_KEEP_REQUEST", "off");
	sections = {};
	completeSimple.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("warming an idle session's cache", () => {
	it("sends the last request again 54 minutes after it went out, capped at one token", async () => {
		const { sent } = await idleSession();

		await wait(WARM_EVERY - 1);
		expect(sent).toHaveLength(0);
		await wait(1);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.body).toEqual({ ...payload, max_tokens: 1 });
		expect(sent[0]?.options).toMatchObject({
			headers: { "pi-session-id": "s1" },
			sessionId: "s1",
			maxTokens: 1,
			maxRetries: 0,
		});
	});

	it("warms every 54 minutes, four times at most", async () => {
		const { sent } = await idleSession();

		await wait(4 * WARM_EVERY);
		expect(sent).toHaveLength(4);
		await wait(10 * WARM_EVERY);
		expect(sent).toHaveLength(4);
	});

	it("records each warm with its usage and cost, in the shape the spend ledger counts", async () => {
		const { entries } = await idleSession();

		await wait(2 * WARM_EVERY);

		expect(warms(entries)).toEqual([
			{
				type: "compaction-cache-warm",
				data: expect.objectContaining({
					model: "claude-opus-5-5",
					provider: "anthropic",
					warm: 1,
					sinceRequestMs: WARM_EVERY,
					usage: expect.objectContaining({
						cacheRead: 188_000,
						cost: expect.objectContaining({ total: 0.037632 }),
					}),
				}),
			},
			expect.objectContaining({ data: expect.objectContaining({ warm: 2 }) }),
		]);
	});

	it("is billed by the spend ledger as a side call on the session's model", async () => {
		const { entries } = await idleSession();
		await wait(WARM_EVERY);
		const [warm] = warms(entries);
		const line = JSON.stringify({
			type: "custom",
			id: "w1",
			timestamp: "2026-11-05T18:00:00.000Z",
			customType: warm?.type,
			data: warm?.data,
		});

		const [turn] = readTurns("s1", [line]).turns;

		expect(turn).toMatchObject({
			kind: "side",
			model: "claude-opus-5-5",
			cost: { total: 0.037632 },
			tokens: { cacheRead: 188_000, output: 1 },
		});
	});

	it("takes no part in the conversation", async () => {
		const { sent } = await idleSession();
		await wait(WARM_EVERY);
		// The context handed to pi is empty; the request is the held one.
		expect(sent[0]?.body).toMatchObject({ messages: payload.messages });
	});
});

describe("what stops warming", () => {
	const realEvents: Array<[string, string, unknown]> = [
		["a typed prompt", "input", { text: "hi", source: "interactive" }],
		["a run starting", "before_agent_start", { prompt: "hi" }],
		["a run started", "agent_start", {}],
		["a finished compaction", "session_compact", { compactionEntry: {} }],
		["a model change", "model_select", { source: "set" }],
		["a thinking change", "thinking_level_select", { level: "low" }],
		["moving in the tree", "session_tree", { newLeafId: "x" }],
		["a reload", "session_shutdown", { reason: "reload" }],
		["quitting", "session_shutdown", { reason: "quit" }],
		["another session starting", "session_start", { reason: "new" }],
	];

	for (const [what, name, event] of realEvents) {
		it(`stops at ${what}`, async () => {
			const { fire, sent, ctx } = await idleSession();
			await wait(WARM_EVERY);
			expect(sent).toHaveLength(1);

			await fire(name, event, ctx);
			await wait(4 * WARM_EVERY);

			expect(sent).toHaveLength(1);
		});
	}

	it("stops when a compaction is under way as a warm falls due", async () => {
		const { state, sent } = await idleSession();
		await wait(WARM_EVERY);
		// pi counts a session compacting as not idle.
		state.idle = false;
		await wait(WARM_EVERY);
		state.idle = true;
		await wait(3 * WARM_EVERY);
		expect(sent).toHaveLength(1);
	});

	it("stops when the package config switches it off", async () => {
		const { sent, entries } = await idleSession();
		await wait(WARM_EVERY);
		sections = { compaction: { warmWhileIdle: false } };

		await wait(3 * WARM_EVERY);

		expect(sent).toHaveLength(1);
		expect(stops(entries)).toHaveLength(0);
	});

	it("never starts when the package config has it off", async () => {
		sections = { compaction: { warmWhileIdle: false } };
		const { sent } = await idleSession();
		await wait(4 * WARM_EVERY);
		expect(sent).toHaveLength(0);
	});

	it("stops after a warm that wrote its prefix, and says why", async () => {
		const { state, sent, entries } = await idleSession();
		state.replies.push(warmReply(2_001));

		await wait(4 * WARM_EVERY);

		expect(sent).toHaveLength(1);
		expect(warms(entries)).toHaveLength(1);
		expect(stops(entries)).toEqual([
			{
				type: "compaction-cache-warm-stopped",
				data: {
					reason: expect.stringContaining("wrote 2001 tokens"),
					warms: 1,
				},
			},
		]);
	});

	it("carries on after a warm that wrote a little", async () => {
		const { state, sent } = await idleSession();
		state.replies.push(warmReply(2_000));
		await wait(2 * WARM_EVERY);
		expect(sent).toHaveLength(2);
	});

	it("gives up on a timer that ran too late to find the entry warm", async () => {
		const { fire, entries } = activate();
		const { sent, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		await turn(fire, ctx);
		// The machine slept: the clock jumped past the warm's deadline
		// before the timer could run.
		vi.setSystemTime(Date.now() + WARM_EVERY + 4 * MINUTE);
		await wait(WARM_EVERY);

		expect(sent).toHaveLength(0);
		expect(stops(entries)[0]?.data).toMatchObject({
			reason: expect.stringContaining("too late"),
		});
	});

	it("tries a failed warm once more, then stops and says why", async () => {
		const { state, sent, entries } = await idleSession();
		const failed = {
			...warmReply(),
			stopReason: "error",
			errorMessage: "overloaded",
		};
		state.replies.push(failed, failed);

		await wait(WARM_EVERY);
		expect(sent).toHaveLength(1);
		await wait(30_000);
		expect(sent).toHaveLength(2);
		await wait(4 * WARM_EVERY);

		expect(sent).toHaveLength(2);
		expect(warms(entries)).toHaveLength(0);
		expect(stops(entries)[0]?.data).toMatchObject({
			reason: "the warm failed: overloaded",
		});
	});

	it("warms nothing a session did not send as a turn of its own", async () => {
		const { fire, entries } = activate();
		const { sent, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		// A summary or a warm of pi's own: no `context` before it.
		await fire("before_provider_request", { payload }, ctx);
		await fire("agent_settled", { aborted: false }, ctx);
		await wait(4 * WARM_EVERY);
		expect(sent).toHaveLength(0);
		expect(entries).toHaveLength(0);
	});

	it("warms nothing with budget-based thinking or a five-minute cache", async () => {
		const budget = {
			...payload,
			thinking: { type: "enabled", budget_tokens: 4096 },
		};
		const short = {
			...payload,
			system: [
				{ type: "text", text: "s", cache_control: { type: "ephemeral" } },
			],
			messages: [],
		};
		for (const body of [budget, short]) {
			const { fire } = activate();
			const { sent, ctx } = session();
			await fire("session_start", { reason: "startup" }, ctx);
			await turn(fire, ctx, body);
			await wait(4 * WARM_EVERY);
			expect(sent).toHaveLength(0);
		}
	});

	it("stops, rather than taking pi down, when a warm breaks", async () => {
		const { fire } = activate(true);
		const { sent, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		await turn(fire, ctx);
		await wait(4 * WARM_EVERY);
		// An unhandled rejection would fail this test.
		expect(sent).toHaveLength(1);
	});

	it("warms nothing in a subagent, which ends with its run", async () => {
		const { fire } = activate();
		const { sent, ctx } = session();
		ctx.mode = "json";
		await fire("session_start", { reason: "startup" }, ctx);
		await turn(fire, ctx);
		await wait(4 * WARM_EVERY);
		expect(sent).toHaveLength(0);
	});
});

describe("warming and compacting while idle", () => {
	it("holds idle compaction off while warming, then compacts five minutes before the last warm expires", async () => {
		const { state } = await idleSession();
		// Large enough that compacting while idle pays.
		state.tokens = 280_000;

		await wait(4 * WARM_EVERY);
		expect(state.compactions).toBe(0);
		await wait(55 * MINUTE - 1);
		expect(state.compactions).toBe(0);
		await wait(1);
		expect(state.compactions).toBe(1);
	});
});
