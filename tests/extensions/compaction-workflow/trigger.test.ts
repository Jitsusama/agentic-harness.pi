/**
 * The trigger, wired up: it compacts once the rent the droppable
 * context has paid reaches what compacting costs, writes the summary
 * in the background so the session never waits for it, and compacts an
 * idle session just before its cache expires when that pays.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const { default: compactionWorkflow } = await import(
	"../../../extensions/compaction-workflow/index.ts"
);

type Handler = (event: unknown, ctx: unknown) => unknown;
type CompactOptions = { onComplete?: () => void; onError?: (e: Error) => void };

function activate() {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const resumed: unknown[] = [];
	const pi = {
		events: {
			on: (channel: string, h: (data: unknown) => void) =>
				listeners.set(channel, [...(listeners.get(channel) ?? []), h]),
			emit: (channel: string, data: unknown) => {
				for (const h of listeners.get(channel) ?? []) h(data);
			},
		},
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: (text: unknown) => resumed.push(text),
	};
	compactionWorkflow(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		let result: unknown;
		for (const h of handlers.get(name) ?? []) result = await h(event, ctx);
		return result;
	};
	return { fire, resumed };
}

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

/** A session whose size, idleness and branch the test moves. */
function session() {
	const state = {
		tokens: 60_000,
		idle: false,
		branch: [userEntry] as unknown[],
		leaf: "u1" as string | null,
		compactions: [] as CompactOptions[],
	};
	const ctx = {
		mode: "rpc",
		hasUI: false,
		model: {
			id: "claude-opus-5-5",
			api: "anthropic-messages",
			provider: "anthropic",
			maxTokens: 128_000,
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		},
		getContextUsage: () => ({ tokens: state.tokens }),
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		compact: (options: CompactOptions) => state.compactions.push(options),
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
		},
		sessionManager: {
			getBranch: () => state.branch,
			getLeafId: () => state.leaf,
			getSessionId: () => "s1",
		},
	};
	return { state, ctx };
}

const payload = {
	model: "claude-opus-5-5",
	messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
};

const ranTools = { message: {}, toolResults: [{}] };

/**
 * A session at 300k after a 60k first turn, short retention: each turn
 * pays (300k - 90k kept) x $0.20/M = $0.042 in rent, against a cost of
 * $0.214 summary + $0.432 rewrite + $0.189 re-fetching = $0.835, so the
 * twentieth turn at 300k is the first the rent covers it.
 */
async function toTheEdge(withSentRequest: boolean) {
	const { fire, resumed } = activate();
	const { state, ctx } = session();
	await fire("session_start", { reason: "startup" }, ctx);
	if (withSentRequest) await fire("before_provider_request", { payload }, ctx);
	state.branch = [userEntry, replyEntry];
	state.leaf = "a1";
	await fire("turn_end", ranTools, ctx);
	state.tokens = 300_000;
	for (let turn = 0; turn < 19; turn++) await fire("turn_end", ranTools, ctx);
	return { fire, resumed, state, ctx };
}

beforeEach(() => {
	completeSimple.mockReset();
	vi.stubEnv("PI_CACHE_RETENTION", "short");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("the compaction trigger", () => {
	it("holds off until the rent paid reaches what compacting costs, then writes the summary in the background", async () => {
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const { fire, state, ctx } = await toTheEdge(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(completeSimple).not.toHaveBeenCalled();

		await fire("turn_end", ranTools, ctx);
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
		// Work carries on while it is written: nothing has compacted yet.
		expect(state.compactions).toHaveLength(0);
	});

	it("applies the summary at the next turn's end and resumes the run it interrupted", async () => {
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const { fire, resumed, state, ctx } = await toTheEdge(true);
		await fire("turn_end", ranTools, ctx);
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));

		await fire("turn_end", ranTools, ctx);
		expect(state.compactions).toHaveLength(1);
		state.compactions[0]?.onComplete?.();
		expect(resumed).toHaveLength(1);
	});

	it("compacts on the spot when the summary cannot be written in the background", async () => {
		const { fire, state, ctx } = await toTheEdge(false);
		expect(state.compactions).toHaveLength(0);
		await fire("turn_end", ranTools, ctx);
		expect(state.compactions).toHaveLength(1);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("applies a summary that finishes while the session is idle at once, without resuming", async () => {
		let finish: (value: unknown) => void = () => {};
		completeSimple.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { fire, resumed, state, ctx } = await toTheEdge(true);
		await fire("turn_end", ranTools, ctx);
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

		state.idle = true;
		finish({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		await vi.waitFor(() => expect(state.compactions).toHaveLength(1));
		state.compactions[0]?.onComplete?.();
		expect(resumed).toHaveLength(0);
	});
});

describe("compacting an idle session before its cache expires", () => {
	const FIFTY_FOUR_MINUTES = 54 * 60_000;
	const ONE_MINUTE = 60_000;

	async function idleAt(tokens: number) {
		vi.useFakeTimers();
		vi.stubEnv("PI_CACHE_RETENTION", "long");
		const { fire } = activate();
		const { state, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		await fire("turn_end", ranTools, ctx);
		state.tokens = tokens;
		await fire("turn_end", ranTools, ctx);
		state.idle = true;
		await fire("agent_end", {}, ctx);
		return { fire, state, ctx };
	}

	it("compacts a large context five minutes before the hour is up", async () => {
		// Back after the hour, 280k would be written at $8/M; compacted,
		// only the 90k kept is. $1.52 avoided against about $0.40.
		const { state } = await idleAt(280_000);
		vi.advanceTimersByTime(FIFTY_FOUR_MINUTES);
		expect(state.compactions).toHaveLength(0);
		vi.advanceTimersByTime(ONE_MINUTE);
		expect(state.compactions).toHaveLength(1);
	});

	it("leaves a context barely past what a compaction keeps", async () => {
		const { state } = await idleAt(100_000);
		vi.advanceTimersByTime(FIFTY_FOUR_MINUTES + ONE_MINUTE);
		expect(state.compactions).toHaveLength(0);
	});

	it("stands down when the user comes back first", async () => {
		const { fire, state, ctx } = await idleAt(280_000);
		vi.advanceTimersByTime(FIFTY_FOUR_MINUTES);
		state.idle = false;
		await fire("agent_start", {}, ctx);
		vi.advanceTimersByTime(ONE_MINUTE);
		expect(state.compactions).toHaveLength(0);
	});
});
