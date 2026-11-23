/**
 * The trigger, wired up: it compacts once the rent the droppable
 * context has paid reaches what compacting costs, writes the summary
 * in the background so the session never waits for it, and compacts an
 * idle session just before its cache expires when that pays.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { contextUsageOf } from "../../../lib/internal/session/context-usage.ts";
import { endTurn } from "../../support/turn-end.ts";

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
	const entries: Array<{ type: string; data: unknown }> = [];
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
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		registerCommand: () => {},
		sendMessage: () => {},
		sendUserMessage: (text: unknown) => resumed.push(text),
	};
	compactionWorkflow(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		let result: unknown;
		for (const h of handlers.get(name) ?? []) result = await h(event, ctx);
		return result;
	};
	return { fire, resumed, handlers, entries };
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

/**
 * A session whose size, idleness and branch the test moves. A context
 * that changes size has had an entry appended, so setting `tokens` moves
 * the leaf onto a fresh copy of the branch's last entry, as pi's append
 * would.
 */
function session() {
	let tokens = 60_000;
	let appended = 0;
	const state = {
		get tokens() {
			return tokens;
		},
		set tokens(size: number) {
			tokens = size;
			const last = state.branch.at(-1);
			if (state.leaf === null || !isEntry(last)) return;
			appended += 1;
			const id = `${last.id}.${appended}`;
			state.branch = [...state.branch.slice(0, -1), { ...last, id }];
			state.leaf = id;
		},
		asks: 0,
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
		getContextUsage: () => {
			state.asks += 1;
			return {
				tokens: state.tokens,
				contextWindow: WINDOW,
				percent: (100 * state.tokens) / WINDOW,
			};
		},
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

/** The context window the stand-in session's usage is a share of. */
const WINDOW = 1_000_000;

function isEntry(
	value: unknown,
): value is Record<string, unknown> & { id: string } {
	return isRecord(value) && typeof value.id === "string";
}

const payload = {
	model: "claude-opus-5-5",
	messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
};

const ranTools = { message: {}, toolResults: [{}] };

/**
 * A session at 300k after a 60k first turn, short retention: each turn
 * pays (300k - 90k kept) x $0.20/M = $0.042 in rent, against a cost of
 * $0.312 summary + $0.432 rewrite + $0.189 re-fetching = $0.933, so the
 * twenty-third turn at 300k is the first the rent covers it.
 *
 * With nothing sent, the conversation provider declines and pi's
 * summariser would write it, reading the context uncached: the summary
 * is $1.20 + $0.252 and the whole $2.073, so it is the fiftieth.
 */
async function toTheEdge(withSentRequest: boolean) {
	const { fire, resumed, entries } = activate();
	const { state, ctx } = session();
	await fire("session_start", { reason: "startup" }, ctx);
	if (withSentRequest) await fire("before_provider_request", { payload }, ctx);
	state.branch = [userEntry, replyEntry];
	state.leaf = "a1";
	await endTurn(fire, ranTools, ctx);
	state.tokens = 300_000;
	const short = withSentRequest ? 22 : 49;
	for (let turn = 0; turn < short; turn++) await endTurn(fire, ranTools, ctx);
	return { fire, resumed, entries, state, ctx };
}

beforeEach(() => {
	completeSimple.mockReset();
	vi.stubEnv("PI_CACHE_RETENTION", "short");
	vi.stubEnv("PI_COMPACTION_CEILING_TOKENS", undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("the compaction trigger", () => {
	it("answers a compaction from one handler, whichever provider writes it", () => {
		const { handlers } = activate();
		expect(handlers.get("session_before_compact")).toHaveLength(1);
	});

	it("reads a turn's context size from the reading other extensions took at that leaf", async () => {
		const { fire } = activate();
		const { state, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		state.branch = [userEntry, replyEntry];
		state.leaf = "a1";
		state.tokens = 120_000;
		contextUsageOf(ctx);
		state.asks = 0;

		await endTurn(fire, ranTools, ctx);

		expect(state.asks, "pi rebuilt the context's usage again").toBe(0);
	});

	it("holds off until the rent paid reaches what compacting costs, then writes the summary in the background", async () => {
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const { fire, state, ctx } = await toTheEdge(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(completeSimple).not.toHaveBeenCalled();

		await endTurn(fire, ranTools, ctx);
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
		// Work carries on while it is written: nothing has compacted yet.
		expect(state.compactions).toHaveLength(0);
	});

	it("writes the summary at the first turn past the ceiling, before the rent has paid", async () => {
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		vi.stubEnv("PI_COMPACTION_CEILING_TOKENS", "200000");
		const { fire } = activate();
		const { state, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		await fire("before_provider_request", { payload }, ctx);
		state.branch = [userEntry, replyEntry];
		state.leaf = "a1";
		await endTurn(fire, ranTools, ctx);
		state.tokens = 199_000;
		await endTurn(fire, ranTools, ctx);
		// One tick, for a summary the turn would have started to be asked for.
		await new Promise((r) => setTimeout(r, 0));
		expect(completeSimple).not.toHaveBeenCalled();

		state.tokens = 250_000;
		await endTurn(fire, ranTools, ctx);
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
	});

	it("has no ceiling unless one is set", async () => {
		const { fire } = activate();
		const { state, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		await fire("before_provider_request", { payload }, ctx);
		state.branch = [userEntry, replyEntry];
		state.leaf = "a1";
		await endTurn(fire, ranTools, ctx);
		state.tokens = 250_000;
		await endTurn(fire, ranTools, ctx);
		// One tick, for a summary the turn would have started to be asked for.
		await new Promise((r) => setTimeout(r, 0));
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("applies the summary at the next turn's end and resumes the run it interrupted", async () => {
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const { fire, resumed, state, ctx } = await toTheEdge(true);
		await endTurn(fire, ranTools, ctx);
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));

		await endTurn(fire, ranTools, ctx);
		expect(state.compactions).toHaveLength(1);
		state.compactions[0]?.onComplete?.();
		expect(resumed).toHaveLength(1);
	});

	it("compacts on the spot when the summary cannot be written in the background", async () => {
		const { fire, state, ctx } = await toTheEdge(false);
		expect(state.compactions).toHaveLength(0);
		await endTurn(fire, ranTools, ctx);
		expect(state.compactions).toHaveLength(1);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	// On 22 November four summaries written ahead failed, and each next
	// turn compacted on the spot, holding the session 7 to 16 minutes.
	describe("after a summary written ahead failed", () => {
		const written = {
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		};
		const capped = {
			stopReason: "length",
			content: [{ type: "text", text: "## Goal\nand on and" }],
			usage: {},
		};
		// Failed in a way no second call mends, so nothing is retried within
		// the write.
		const refused = {
			stopReason: "toolUse",
			content: [{ type: "toolCall", name: "read" }],
			usage: {},
		};
		const closingOf = (call: number) =>
			JSON.stringify(
				(
					completeSimple.mock.calls[call]?.[1] as
						| { messages: unknown[] }
						| undefined
				)?.messages.at(-1),
			);

		/** The session at the edge, its first summary ahead failed. */
		async function failedOnce(first: unknown) {
			completedSimply(first);
			const at = await toTheEdge(true);
			await endTurn(at.fire, ranTools, at.ctx);
			await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
			await new Promise((r) => setTimeout(r, 0));
			return at;
		}
		/** pi asking for the summary of the compaction it has begun. */
		const compactEvent = () => ({
			preparation: {
				firstKeptEntryId: "a1",
				tokensBefore: 300_000,
				previousSummary: undefined,
				fileOps: { read: new Set(), edited: new Set(), written: new Set() },
				settings: { reserveTokens: 64_000 },
			},
			customInstructions: undefined,
			signal: new AbortController().signal,
		});
		const completedSimply = (first: unknown) => {
			completeSimple.mockResolvedValueOnce(first);
			completeSimple.mockResolvedValue(written);
		};

		it("writes it ahead again rather than compacting on the spot", async () => {
			const { fire, state, ctx } = await failedOnce(refused);

			await endTurn(fire, ranTools, ctx);
			expect(state.compactions, "compacted on the spot").toHaveLength(0);
			await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(2));
			await new Promise((r) => setTimeout(r, 0));

			// The second is applied as any written ahead is.
			await endTurn(fire, ranTools, ctx);
			expect(state.compactions).toHaveLength(1);
			// A failure that didn't stop at the cap asks the same size again.
			expect(closingOf(1)).toContain("Make it about");
		});

		it("asks less on the spot after a write ahead the compaction waited on stopped at its cap", async () => {
			let finish: (value: unknown) => void = () => {};
			completeSimple.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			completeSimple.mockResolvedValue(written);
			const { fire, entries, ctx } = await toTheEdge(true);
			await endTurn(fire, ranTools, ctx);
			await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));

			// pi compacts at its own threshold while the summary is written.
			const compacting = fire("session_before_compact", compactEvent(), ctx);
			finish(capped);
			await compacting;

			expect(completeSimple).toHaveBeenCalledTimes(2);
			expect(closingOf(1)).toContain("Keep it to at most");
			// Recorded once, saying which try it was and whether it was halved.
			expect(
				entries.filter((entry) => entry.type === "compaction-ahead-unused"),
			).toEqual([
				{
					type: "compaction-ahead-unused",
					data: expect.objectContaining({ tries: 1, halved: false }),
				},
			]);
		});

		it("asks for a shorter summary after one that stopped at its cap", async () => {
			const { fire, ctx } = await failedOnce(capped);
			await endTurn(fire, ranTools, ctx);
			await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(2));

			expect(closingOf(0)).toContain("Make it about");
			expect(closingOf(1)).toContain("Keep it to at most");
			expect(closingOf(1)).toContain("a limit, not a target");
		});

		it("compacts on the spot once a second try ahead has failed too", async () => {
			completeSimple.mockResolvedValue(capped);
			const { fire, state, ctx } = await toTheEdge(true);
			await endTurn(fire, ranTools, ctx);
			await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
			await new Promise((r) => setTimeout(r, 0));
			await endTurn(fire, ranTools, ctx);
			await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(2));
			await new Promise((r) => setTimeout(r, 0));
			expect(state.compactions).toHaveLength(0);

			await endTurn(fire, ranTools, ctx);
			expect(state.compactions).toHaveLength(1);
			expect(completeSimple).toHaveBeenCalledTimes(2);
		});

		/** The session at the edge, two summaries ahead failed at their cap. */
		async function failedTwice() {
			completeSimple.mockResolvedValue(capped);
			const at = await toTheEdge(true);
			for (let tried = 1; tried <= 2; tried++) {
				await endTurn(at.fire, ranTools, at.ctx);
				await vi.waitFor(() =>
					expect(completeSimple).toHaveBeenCalledTimes(tried),
				);
				await new Promise((r) => setTimeout(r, 0));
			}
			return at;
		}
		/**
		 * The conversation back at the edge with a summary ahead to fail once
		 * more: whether the turn after it compacts on the spot.
		 */
		async function compactsOnTheSpotAgain({
			fire,
			state,
			ctx,
		}: Awaited<ReturnType<typeof failedTwice>>) {
			const before = completeSimple.mock.calls.length;
			const compacted = state.compactions.length;
			// The first turn measures what is kept; the next request is sent and
			// the conversation grows back to the edge.
			state.tokens = 60_000;
			await endTurn(fire, ranTools, ctx);
			state.branch = [userEntry];
			state.leaf = "u1";
			await fire("before_provider_request", { payload }, ctx);
			state.branch = [userEntry, replyEntry];
			state.leaf = "a1";
			state.tokens = 300_000;

			completeSimple.mockResolvedValueOnce(refused);
			for (let turn = 0; turn < 40; turn++) {
				await endTurn(fire, ranTools, ctx);
				if (completeSimple.mock.calls.length > before) break;
			}
			await vi.waitFor(() =>
				expect(completeSimple).toHaveBeenCalledTimes(before + 1),
			);
			await new Promise((r) => setTimeout(r, 0));
			await endTurn(fire, ranTools, ctx);
			return state.compactions.length > compacted;
		}

		it("tries ahead afresh for the next compaction once one has landed", async () => {
			const at = await failedTwice();
			const { fire, state, ctx } = at;
			await endTurn(fire, ranTools, ctx);
			expect(state.compactions).toHaveLength(1);
			// pi asks for the summary, which fails again on the spot, asked for
			// less; pi's own summariser lands the compaction.
			await fire("session_before_compact", compactEvent(), ctx);
			expect(closingOf(2)).toContain("Keep it to at most");
			await fire("session_compact", { compactionEntry: {} }, ctx);
			state.compactions[0]?.onComplete?.();

			expect(await compactsOnTheSpotAgain(at), "compacted on the spot").toBe(
				false,
			);
			expect(closingOf(3), "asked full size again").toContain("Make it about");
		});

		it.each([
			["the session starts again", "session_start", { reason: "resume" }],
			[
				"the session moves in its tree",
				"session_tree",
				{ newLeafId: "a1", oldLeafId: "a1" },
			],
		])("tries ahead afresh once %s", async (_, name, event) => {
			const at = await failedTwice();
			await at.fire(name, event, at.ctx);

			expect(await compactsOnTheSpotAgain(at), "compacted on the spot").toBe(
				false,
			);
			expect(closingOf(2), "asked full size again").toContain("Make it about");
		});
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
		await endTurn(fire, ranTools, ctx);
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

/**
 * pi's compact() stops the run and waits for the session to go idle,
 * but a prompt sent as the stopped run settles starts the next run
 * first. On 9 November two sessions waited about nine hours that way,
 * with nothing in their logs to say so.
 */
describe("a compaction overtaken by a run", () => {
	const stalls = (entries: ReadonlyArray<{ type: string }>) =>
		entries.filter((entry) => entry.type === "compaction-stalled");

	it("is logged when a run starts before the compaction it asked for begins", async () => {
		const { fire, entries, state, ctx } = await toTheEdge(false);
		await endTurn(fire, ranTools, ctx);
		expect(state.compactions, "the trigger asked pi to compact").toHaveLength(
			1,
		);

		await fire("agent_start", {}, ctx);
		await fire("agent_start", {}, ctx);

		expect(stalls(entries)).toHaveLength(1);
		expect(stalls(entries)[0]).toMatchObject({
			data: { contextTokens: 300_000 },
		});
	});

	it("is not logged for the run a landed compaction resumes", async () => {
		const { fire, entries, state, ctx } = await toTheEdge(false);
		await endTurn(fire, ranTools, ctx);
		await fire("session_compact", { compactionEntry: {} }, ctx);
		state.compactions[0]?.onComplete?.();

		await fire("agent_start", {}, ctx);

		expect(stalls(entries)).toEqual([]);
	});
});

/**
 * What the first turn after a compaction reads is what the next one is
 * expected to keep, and only the rest pays rent. On 9 November two
 * compactions that had waited nine hours kept 510k and 616k; counted
 * from there, the next waited until 748k and 903k.
 */
describe("a compaction that kept an outsized amount", () => {
	const LIMIT = 400;

	/** Turns at `tokens` until the trigger asks pi to compact again. */
	async function turnsUntilCompacting(
		fire: (name: string, event: unknown, ctx: unknown) => Promise<unknown>,
		state: ReturnType<typeof session>["state"],
		ctx: unknown,
		tokens: number,
	) {
		const before = state.compactions.length;
		state.tokens = tokens;
		for (let turn = 1; turn <= LIMIT; turn++) {
			await endTurn(fire, ranTools, ctx);
			if (state.compactions.length > before) return turn;
		}
		return LIMIT;
	}

	async function fresh() {
		const { fire } = activate();
		const { state, ctx } = session();
		await fire("session_start", { reason: "startup" }, ctx);
		state.branch = [userEntry, replyEntry];
		state.leaf = "a1";
		await endTurn(fire, ranTools, ctx);
		return turnsUntilCompacting(fire, state, ctx, 600_000);
	}

	it("does not set what the next compaction is expected to keep", async () => {
		const { fire, state, ctx } = await toTheEdge(false);
		await endTurn(fire, ranTools, ctx);
		await fire("session_compact", { compactionEntry: {} }, ctx);
		state.tokens = 510_000;
		await endTurn(fire, ranTools, ctx);

		const after = await turnsUntilCompacting(fire, state, ctx, 600_000);
		const usual = await fresh();

		expect(usual, "a fresh session compacts at 600k").toBeLessThan(LIMIT);
		// The 510k turn paid rent of its own, so it may come a turn sooner.
		expect(after).toBeLessThanOrEqual(usual);
	});

	it("is not taken from the log of a resumed session either", async () => {
		const prompt = (id: string, input: number) => ({
			...replyEntry,
			id,
			message: { ...replyEntry.message, usage: { input } },
		});
		const { fire } = activate();
		const { state, ctx } = session();
		state.branch = [
			userEntry,
			prompt("a1", 60_000),
			{ type: "compaction", id: "c1" },
			prompt("a2", 510_000),
		];
		state.leaf = "a2";
		await fire("session_start", { reason: "resume" }, ctx);

		const after = await turnsUntilCompacting(fire, state, ctx, 600_000);

		expect(after).toBeLessThanOrEqual(await fresh());
	});

	it("still sets it when the keep is near what compactions keep", async () => {
		const { fire, state, ctx } = await toTheEdge(false);
		await endTurn(fire, ranTools, ctx);
		await fire("session_compact", { compactionEntry: {} }, ctx);
		state.tokens = 150_000;
		await endTurn(fire, ranTools, ctx);

		const after = await turnsUntilCompacting(fire, state, ctx, 600_000);

		expect(after, "less rent a turn above a 150k keep").toBeGreaterThan(
			await fresh(),
		);
	});
});

/**
 * A turn whose request failed or was stopped is where pi retries, or
 * where somebody pressed Escape. Compacting there aborts the run pi was
 * about to retry, so the trigger waits for a turn that completed.
 */
describe("a turn that did not complete", () => {
	const failed = {
		message: { stopReason: "error" },
		toolResults: [],
		outcome: "error",
	};
	const stopped = {
		message: { stopReason: "aborted" },
		toolResults: [],
		outcome: "aborted",
	};

	it.each([
		["failed", failed],
		["was stopped", stopped],
	])("never compacts on the spot on a turn that %s", async (_, turn) => {
		const { fire, state, ctx } = await toTheEdge(false);
		await endTurn(fire, turn, ctx);
		expect(state.compactions).toHaveLength(0);

		await endTurn(fire, ranTools, ctx);
		expect(state.compactions).toHaveLength(1);
	});

	it("reads a failure from the stop reason where pi gives no outcome", async () => {
		const { fire, state, ctx } = await toTheEdge(false);
		await endTurn(
			fire,
			{ message: { stopReason: "error" }, toolResults: [] },
			ctx,
		);
		expect(state.compactions).toHaveLength(0);
	});

	it("holds a summary written ahead until the next turn that completes", async () => {
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const { fire, state, ctx } = await toTheEdge(true);
		await endTurn(fire, ranTools, ctx);
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));

		await endTurn(fire, failed, ctx);
		expect(state.compactions).toHaveLength(0);
		await endTurn(fire, ranTools, ctx);
		expect(state.compactions).toHaveLength(1);
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
		await fire("before_provider_request", { payload }, ctx);
		state.branch = [userEntry, replyEntry];
		state.leaf = "a1";
		await endTurn(fire, ranTools, ctx);
		state.tokens = tokens;
		await endTurn(fire, ranTools, ctx);
		state.idle = true;
		await fire("agent_end", {}, ctx);
		return { fire, state, ctx };
	}

	it("compacts a large context five minutes before the hour is up", async () => {
		// Back after the hour, 280k would be written at $8/M; compacted,
		// only the 90k kept is. $1.52 avoided against about $0.50: the
		// summary read from cache and written, and the re-fetching.
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
