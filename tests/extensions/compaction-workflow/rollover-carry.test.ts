/**
 * A rollover carries the session's first prompt into the fresh log, so
 * the trigger there still knows the fixed overhead its first turn,
 * left in the parent log, paid.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import compactionWorkflow from "../../../extensions/compaction-workflow/index.ts";
import {
	compactionHistory,
	FIRST_PROMPT_CARRY,
} from "../../../lib/compaction/history.ts";
import {
	type Carry,
	ROLLOVER_CARRY,
	ROLLOVER_RECORD,
} from "../../../lib/internal/session/rollover.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Just enough of pi for the extension to register and hear the bus. */
function activate(): {
	handlers: Map<string, Handler>;
	emit: (name: string, data: unknown) => void;
} {
	const handlers = new Map<string, Handler>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const pi = {
		events: {
			on: (name: string, listener: (data: unknown) => void) => {
				listeners.set(name, [...(listeners.get(name) ?? []), listener]);
				return () => {};
			},
			emit: () => {},
		},
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: () => {},
		registerCommand: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	compactionWorkflow(pi as unknown as ExtensionAPI);
	return {
		handlers,
		emit: (name, data) => {
			for (const listener of listeners.get(name) ?? []) listener(data);
		},
	};
}

/** An assistant turn whose prompt was `prompt` tokens. */
function turn(prompt: number) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { input: prompt, cacheRead: 0, cacheWrite: 0 },
		},
	};
}

/** A started session whose log holds `branch`. */
function context(branch: unknown[]) {
	return {
		mode: "rpc",
		hasUI: false,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 1 }),
		model: {
			api: "anthropic-messages",
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		},
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => null,
			getSessionId: () => "s1",
		},
	};
}

describe("a rollover from a session the compaction workflow follows", () => {
	it("carries the session's first prompt into the fresh log", async () => {
		const { handlers, emit } = activate();
		await handlers.get("session_start")?.(
			{ reason: "startup" },
			context([turn(40_000), turn(130_000)]),
		);
		const carry: Carry = { carried: {} };
		emit(ROLLOVER_CARRY, carry);
		const fresh = [
			{
				type: "custom",
				customType: ROLLOVER_RECORD,
				data: { parentSession: "/p.jsonl", parentLeaf: "p", ...carry },
			},
			turn(130_000),
		];
		expect(compactionHistory(fresh).firstPromptTokens).toBe(40_000);
	});

	it("carries nothing before the session has had a turn", async () => {
		const { handlers, emit } = activate();
		await handlers.get("session_start")?.({ reason: "startup" }, context([]));
		const carry: Carry = { carried: {} };
		emit(ROLLOVER_CARRY, carry);
		expect(carry.carried[FIRST_PROMPT_CARRY]).toBeUndefined();
	});
});
