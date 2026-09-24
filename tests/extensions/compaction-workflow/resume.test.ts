/**
 * A run the compaction interrupted resumes as a prompt, wired up.
 *
 * pi starts a run from `sendMessage(..., { triggerTurn: true })`
 * without emitting `before_agent_start`, so that run is built on the
 * base system prompt: none of what extensions append there (the
 * resident conventions, the loaded quest) reaches it. Measured on pi
 * 0.87.1, the resumed request's system prompt was 4,813 characters
 * shorter, missing every captured rule, and the next typed message put
 * them back, which rewrote the whole context after the tool
 * definitions at the cache-write price. `sendUserMessage` goes through
 * pi's prompt path, which emits the hook, so the resumed run carries
 * the same system prompt a typed message would.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import compactionWorkflow from "../../../extensions/compaction-workflow/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Recorded {
	sendMessage: unknown[][];
	sendUserMessage: unknown[][];
}

/** Just enough of pi for the extension to register and be driven. */
function activate(): { handlers: Map<string, Handler>; calls: Recorded } {
	const handlers = new Map<string, Handler>();
	const calls: Recorded = { sendMessage: [], sendUserMessage: [] };
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: () => {},
		sendMessage: (...args: unknown[]) => calls.sendMessage.push(args),
		sendUserMessage: (...args: unknown[]) => calls.sendUserMessage.push(args),
	};
	compactionWorkflow(pi as unknown as ExtensionAPI);
	return { handlers, calls };
}

/** A session context whose compaction ends the way `outcome` says. */
function context(
	tokens: () => number,
	outcome: (options: {
		onComplete?: () => void;
		onError?: (error: Error) => void;
	}) => void,
) {
	return {
		mode: "rpc",
		hasUI: false,
		getContextUsage: () => ({ tokens: tokens() }),
		model: {
			api: "anthropic-messages",
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		},
		hasPendingMessages: () => false,
		compact: outcome,
		sessionManager: { getBranch: () => [] },
	};
}

/** Drive turns that made tool calls until the policy compacts. */
async function runUntilCompaction(
	outcome: Parameters<typeof context>[1],
): Promise<Recorded> {
	const { handlers, calls } = activate();
	let size = 60_000;
	let compacted = false;
	const ctx = context(
		() => size,
		(options) => {
			compacted = true;
			outcome(options);
		},
	);
	await handlers.get("session_start")?.({}, ctx);
	const turnEnd = handlers.get("turn_end");
	if (turnEnd === undefined) throw new Error("no turn_end handler");
	await turnEnd({ toolResults: [{}] }, ctx);
	size = 900_000;
	for (let turn = 0; turn < 200 && !compacted; turn++) {
		await turnEnd({ toolResults: [{}] }, ctx);
	}
	if (!compacted) throw new Error("the policy never compacted");
	return calls;
}

let wasRate: string | undefined;

beforeEach(() => {
	wasRate = process.env.PI_COMPACTION_EXPLORATION_RATE;
	process.env.PI_COMPACTION_EXPLORATION_RATE = "0";
});

afterEach(() => {
	if (wasRate === undefined) delete process.env.PI_COMPACTION_EXPLORATION_RATE;
	else process.env.PI_COMPACTION_EXPLORATION_RATE = wasRate;
});

describe("resuming the run a compaction interrupted", () => {
	it("resumes after a compaction through the prompt path", async () => {
		const calls = await runUntilCompaction((options) => options.onComplete?.());

		expect(calls.sendMessage).toEqual([]);
		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/compacted/);
	});

	it("resumes after a failed compaction through the prompt path", async () => {
		const calls = await runUntilCompaction((options) =>
			options.onError?.(new Error("Summarization failed")),
		);

		expect(calls.sendMessage).toEqual([]);
		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/failed/);
	});
});
