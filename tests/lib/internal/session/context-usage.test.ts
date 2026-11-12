/**
 * The context's usage, read from pi once per leaf and model, however
 * many extensions ask, and held apart for each session.
 */

import {
	calculateContextTokens,
	estimateTokens,
	getLatestCompactionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	contextUsageOf,
	type UsageContext,
} from "../../../../lib/internal/session/context-usage.ts";

/** A session whose pi counts how often it worked out the usage. */
function session(leaf: string | null = "a1") {
	const state = { leaf, tokens: 1_000, window: 200_000, reads: 0 };
	const manager = { getLeafId: () => state.leaf };
	const ctx = (): UsageContext => ({
		sessionManager: manager,
		model: { id: "claude-opus-5-5", contextWindow: state.window },
		getContextUsage: () => {
			state.reads += 1;
			return {
				tokens: state.tokens,
				contextWindow: state.window,
				percent: (state.tokens / state.window) * 100,
			};
		},
	});
	return { state, ctx };
}

describe("the context's usage, shared between the extensions that ask", () => {
	it("is worked out once while the leaf and the model stay the same", () => {
		const { state, ctx } = session();
		const first = contextUsageOf(ctx());
		const again = contextUsageOf(ctx());
		expect(again).toEqual(first);
		expect(state.reads).toBe(1);
	});

	it("is worked out again once an entry moves the leaf", () => {
		const { state, ctx } = session();
		contextUsageOf(ctx());
		state.leaf = "a2";
		state.tokens = 2_000;
		expect(contextUsageOf(ctx())?.tokens).toBe(2_000);
		expect(state.reads).toBe(2);
	});

	it("is worked out again when the model's window changes", () => {
		const { state, ctx } = session();
		contextUsageOf(ctx());
		state.window = 1_000_000;
		expect(contextUsageOf(ctx())?.contextWindow).toBe(1_000_000);
		expect(state.reads).toBe(2);
	});

	it("is read every time in a session with no entries yet", () => {
		const { state, ctx } = session(null);
		contextUsageOf(ctx());
		contextUsageOf(ctx());
		expect(state.reads).toBe(2);
	});

	it("keeps each session's apart, even at the same leaf", () => {
		const one = session();
		const two = session();
		two.state.tokens = 5_000;
		expect(contextUsageOf(one.ctx())?.tokens).toBe(1_000);
		expect(contextUsageOf(two.ctx())?.tokens).toBe(5_000);
	});
});

const WINDOW = 200_000;

/** An answer from the model, its usage saying how big the context was. */
function answer(contextTokens: number, stopReason = "stop") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Looking at the file now." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 10,
			output: 40,
			cacheRead: contextTokens - 50,
			cacheWrite: 0,
			totalTokens: contextTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} as Parameters<SessionManager["appendMessage"]>[0];
}

function toolResult(text: string) {
	return {
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	} as Parameters<SessionManager["appendMessage"]>[0];
}

function asked(text: string) {
	return {
		role: "user" as const,
		content: text,
		timestamp: Date.now(),
	} as Parameters<SessionManager["appendMessage"]>[0];
}

/**
 * pi's answer, worked out as pi does from the whole projection: the last
 * usable answer's usage and an estimate of what came after it, or no
 * figure when nothing has answered since the latest compaction.
 */
function whatPiSays(manager: SessionManager) {
	const { messages } = manager.buildSessionProjection();
	const branch = manager.getBranch();
	const compaction = getLatestCompactionEntry(branch);
	const usable = (message: (typeof messages)[number]) =>
		message.role === "assistant" &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "error" &&
		calculateContextTokens(message.usage) > 0;
	if (compaction) {
		const after = branch.slice(branch.indexOf(compaction) + 1);
		const answered = after.some(
			(entry) => entry.type === "message" && usable(entry.message),
		);
		if (!answered)
			return { tokens: null, contextWindow: WINDOW, percent: null };
	}
	let last = messages.length - 1;
	while (last >= 0 && !usable(messages[last])) last -= 1;
	const lastMessage = messages[last];
	let tokens =
		lastMessage?.role === "assistant"
			? calculateContextTokens(lastMessage.usage)
			: 0;
	for (const message of messages.slice(last + 1))
		tokens += estimateTokens(message);
	return { tokens, contextWindow: WINDOW, percent: (tokens / WINDOW) * 100 };
}

/** A real session, whose pi counts how often it rebuilt the projection. */
function realSession() {
	const manager = SessionManager.inMemory("/work");
	const state = { reads: 0 };
	const ctx = (): UsageContext => ({
		sessionManager: manager,
		model: { id: "claude-opus-5-5", contextWindow: WINDOW },
		getContextUsage: () => {
			state.reads += 1;
			return whatPiSays(manager);
		},
	});
	return { manager, state, ctx };
}

describe("the context's usage, followed from the entries pi appends", () => {
	it("follows a turn's answers and tool results without rebuilding", () => {
		const { manager, state, ctx } = realSession();
		manager.appendMessage(asked("Read the plan, please."));
		manager.appendMessage(answer(12_000));
		contextUsageOf(ctx());
		manager.appendMessage(toolResult("line\n".repeat(400)));
		const afterTool = contextUsageOf(ctx());
		manager.appendMessage(answer(13_500));
		const afterAnswer = contextUsageOf(ctx());
		manager.appendMessage(asked("And the tests too."));
		const afterAsking = contextUsageOf(ctx());
		expect(state.reads, "pi rebuilt the projection after the first").toBe(1);
		state.reads = 0;
		const truth = whatPiSays(manager);
		expect(afterAsking, "the figure strayed from pi's").toEqual(truth);
		expect(afterAnswer?.tokens, "an answer's usage wasn't taken").toBe(13_500);
		expect(afterTool?.tokens, "the tool result wasn't estimated").toBe(
			12_000 + estimateTokens(toolResult("line\n".repeat(400))),
		);
	});

	it("estimates an answer that was cut off, as pi does", () => {
		const { manager, state, ctx } = realSession();
		manager.appendMessage(answer(9_000));
		contextUsageOf(ctx());
		manager.appendMessage(answer(9_900, "aborted"));
		expect(contextUsageOf(ctx()), "the figure strayed from pi's").toEqual(
			whatPiSays(manager),
		);
		expect(state.reads, "pi rebuilt the projection").toBe(1);
	});

	it("moves nothing for entries that never reach the model", () => {
		const { manager, state, ctx } = realSession();
		const first = manager.appendMessage(answer(9_000));
		const before = contextUsageOf(ctx());
		manager.appendCustomEntry("mesh-presence", { quiet: true });
		manager.appendLabelChange(first, "checkpoint");
		expect(contextUsageOf(ctx()), "the figure moved").toEqual(before);
		expect(state.reads, "pi rebuilt the projection").toBe(1);
	});

	it("stays unknown after a compaction until the model answers", () => {
		const { manager, state, ctx } = realSession();
		const kept = manager.appendMessage(asked("Start here."));
		manager.appendMessage(answer(150_000));
		manager.appendCompaction("What happened so far.", kept, 150_000);
		expect(contextUsageOf(ctx())?.tokens, "known before an answer").toBeNull();
		manager.appendMessage(asked("Carry on."));
		expect(contextUsageOf(ctx())?.tokens, "known before an answer").toBeNull();
		manager.appendMessage(answer(20_000));
		expect(contextUsageOf(ctx())?.tokens, "the answer's usage").toBe(20_000);
		expect(state.reads, "pi rebuilt more than the compaction").toBe(1);
	});

	it("asks pi again after a compaction, since it rewrites the context", () => {
		const { manager, state, ctx } = realSession();
		const kept = manager.appendMessage(asked("Start here."));
		manager.appendMessage(answer(150_000));
		contextUsageOf(ctx());
		manager.appendCompaction("What happened so far.", kept, 150_000);
		contextUsageOf(ctx());
		expect(state.reads, "pi wasn't asked after the compaction").toBe(2);
	});

	it("asks pi again when the leaf moves back up the tree", () => {
		const { manager, state, ctx } = realSession();
		const early = manager.appendMessage(answer(5_000));
		manager.appendMessage(toolResult("later"));
		manager.appendMessage(answer(8_000));
		contextUsageOf(ctx());
		manager.branch(early);
		expect(contextUsageOf(ctx())?.tokens, "the figure at the branch").toBe(
			5_000,
		);
		expect(state.reads, "pi wasn't asked after the move").toBe(2);
	});
});
