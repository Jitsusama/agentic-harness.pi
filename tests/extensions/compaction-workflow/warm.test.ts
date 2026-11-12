/**
 * Idle warming, through the workflow's events: an idle session's last
 * request goes out again with a one-token cap 54 minutes after it was
 * sent and every 54 minutes after, at most four times, and anything
 * real stops it. Fake timers stand in for the hours.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
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
const { addPendingWarm, pendingWarmsDir } = await import(
	"../../../lib/internal/warming-carry.ts"
);
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

/**
 * A session whose idleness and size the test moves. A context that
 * changes size has had an entry appended, so setting `tokens` moves the
 * leaf, as pi's append would.
 */
function session() {
	let tokens = 20_000;
	let appended = 1;
	const state = {
		idle: true,
		get tokens() {
			return tokens;
		},
		set tokens(size: number) {
			tokens = size;
			appended += 1;
		},
		get leaf() {
			return `u${appended}`;
		},
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
			getLeafId: () => state.leaf,
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
	const realEvents: [string, string, unknown][] = [
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

describe("warming across a reload", () => {
	// An install move reloads every idle session; ending its warming there
	// left the next wake to write its whole context to the cache again.
	const reload = async (
		fire: (name: string, event: unknown, ctx: unknown) => Promise<void>,
		ctx: unknown,
	) => {
		await fire("session_shutdown", { reason: "reload" }, ctx);
		const fresh = activate();
		await fresh.fire("session_start", { reason: "reload" }, ctx);
		return fresh;
	};

	it("keeps warming on time in the reloaded extension", async () => {
		const { fire, sent, ctx } = await idleSession();
		await wait(WARM_EVERY + 10 * MINUTE);
		expect(sent).toHaveLength(1);

		const fresh = await reload(fire, ctx);
		await wait(WARM_EVERY - 10 * MINUTE - 1);
		expect(sent).toHaveLength(1);
		await wait(1);

		expect(sent).toHaveLength(2);
		expect(sent[1]?.body).toEqual({ ...payload, max_tokens: 1 });
		expect(warms(fresh.entries)).toEqual([
			expect.objectContaining({ data: expect.objectContaining({ warm: 2 }) }),
		]);
	});

	it("counts the warms before the reload toward the four", async () => {
		const { fire, sent, ctx } = await idleSession();
		await wait(3 * WARM_EVERY);

		await reload(fire, ctx);
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(4);
	});

	it("compacts on time after its warms end, across the reload", async () => {
		const { fire, state, ctx } = await idleSession();
		state.tokens = 280_000;
		await wait(4 * WARM_EVERY + MINUTE);

		await reload(fire, ctx);
		await wait(54 * MINUTE - 1);
		expect(state.compactions).toBe(0);
		await wait(1);
		expect(state.compactions).toBe(1);
	});

	it("carries nothing into a session started any other way", async () => {
		const { fire, sent, ctx } = await idleSession();
		await fire("session_shutdown", { reason: "reload" }, ctx);
		const fresh = activate();
		await fresh.fire("session_start", { reason: "resume" }, ctx);
		await wait(4 * WARM_EVERY);

		expect(sent).toHaveLength(0);
	});
});

describe("warming across a restart", () => {
	// A pi host restarts itself when the install moves, about 25 times a
	// day on 11 November, and each restart ended every idle session's
	// warming: 61 of the day's idle hours went unwarmed, and every one
	// came back to write its whole context to the cache again.
	let state: string;
	beforeEach(() => {
		state = mkdtempSync(join(tmpdir(), "warm-restart-"));
		vi.stubEnv("XDG_STATE_HOME", state);
		vi.stubEnv("PI_COMPACTION_KEEP_REQUEST", "on");
	});
	afterEach(() => rmSync(state, { recursive: true, force: true }));

	const restart = async (
		fire: (name: string, event: unknown, ctx: unknown) => Promise<void>,
		ctx: unknown,
		after = 0,
	) => {
		await fire("session_shutdown", { reason: "quit" }, ctx);
		await wait(after);
		const fresh = activate();
		await fresh.fire("session_start", { reason: "resume" }, ctx);
		return fresh;
	};

	/** Every file under the state folder, read back as text. */
	const onDisk = (dir: string): string[] =>
		readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const raw = readFileSync(join(entry.parentPath, entry.name));
				return entry.name.endsWith(".gz")
					? gunzipSync(raw).toString("utf8")
					: raw.toString("utf8");
			});

	it("keeps warming on time once pi starts the session again", async () => {
		const { fire, sent, ctx } = await idleSession();
		await wait(10 * MINUTE);

		const fresh = await restart(fire, ctx);
		await wait(WARM_EVERY - 10 * MINUTE - 1);
		expect(sent).toHaveLength(0);
		await wait(1);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.body).toEqual({ ...payload, max_tokens: 1 });
		expect(sent[0]?.options).toMatchObject({
			headers: { "pi-session-id": "s1" },
			maxTokens: 1,
		});
		expect(warms(fresh.entries)).toHaveLength(1);
	});

	it("counts the warms before the restart toward the four", async () => {
		const { fire, sent, ctx } = await idleSession();
		await wait(2 * WARM_EVERY + MINUTE);

		await restart(fire, ctx);
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(4);
	});

	it("takes nothing back once the cache it warmed has expired", async () => {
		const { fire, sent, ctx } = await idleSession();

		await restart(fire, ctx, 61 * MINUTE);
		await wait(4 * WARM_EVERY);

		expect(sent).toHaveLength(0);
	});

	it("writes no credential to disk", async () => {
		const { fire } = activate();
		const { ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		await fire("agent_start", {}, ctx);
		await fire("context", { messages: [] }, ctx);
		await fire(
			"before_provider_headers",
			{
				headers: {
					"pi-session-id": "s1",
					Authorization: "Bearer sekrit-1",
					"x-api-key": "sekrit-2",
					"x-forwarded-for": `sk-ant-${"a".repeat(24)}`,
				},
			},
			ctx,
		);
		await fire("before_provider_request", { payload }, ctx);
		await fire("agent_end", { messages: [] }, ctx);
		await fire("agent_settled", { aborted: false }, ctx);

		await fire("session_shutdown", { reason: "quit" }, ctx);
		const written = onDisk(state).join("\n");

		expect([
			written.includes("pi-session-id"),
			written.includes("sekrit"),
			written.includes("sk-ant-"),
		]).toEqual([true, false, false]);
	});

	it("records the warms its host sent while it was parked, once it starts again", async () => {
		const { provider, model, usage } = warmReply();
		addPendingWarm(pendingWarmsDir(), "s1", {
			provider,
			model,
			usage,
			sentAt: 1,
			parked: true,
		});
		const { ctx } = session();

		const fresh = activate();
		await fresh.fire("session_start", { reason: "resume" }, ctx);
		const again = activate();
		await again.fire("session_start", { reason: "resume" }, ctx);

		expect([warms(fresh.entries), warms(again.entries)]).toEqual([
			[
				expect.objectContaining({
					data: expect.objectContaining({ sentAt: 1, parked: true }),
				}),
			],
			[],
		]);
	});

	it("keeps nothing on disk when kept requests are switched off", async () => {
		vi.stubEnv("PI_COMPACTION_KEEP_REQUEST", "off");
		const { fire, sent, ctx } = await idleSession();

		await restart(fire, ctx);
		await wait(4 * WARM_EVERY);

		expect([sent.length, onDisk(state).length]).toEqual([0, 0]);
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
