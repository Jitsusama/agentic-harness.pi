/**
 * The context's usage, read from pi once per leaf and model, however
 * many extensions ask, and held apart for each session.
 */

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
