/**
 * The session the host-*.test.ts files drive the compaction host in:
 * a fake pi with the conversation provider alone in the chain, its
 * branch of one exchange, and the request it last sent.
 *
 * Each file mocks pi-ai's `completeSimple` before importing this, so
 * the host loaded here asks the mock for its summary.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { conversationProvider } from "../../../extensions/compaction-workflow/conversation.ts";
import {
	registerCompactionHost,
	SUMMARY_FALLBACK_ENTRY,
} from "../../../extensions/compaction-workflow/host.ts";
import { COMPACTION_OUTCOME } from "../../../lib/compaction/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Where a reload's request waits on plain pi, as every version names it. */
export const HANDOFF = "agentic-harness.pi:compaction-summary-handoff";

/** Where this file's sessions keep a request across a restart. */
const keptDir = mkdtempSync(join(tmpdir(), "host-kept-"));

/**
 * Load the host into a fresh fake pi, answering with how to fire its
 * events and what it appended, said and wrote.
 */
export function activate() {
	const handlers = new Map<string, Handler[]>();
	const entries: [string, unknown][] = [];
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
	const api = pi as unknown as ExtensionAPI;
	const conversation = conversationProvider(api, { keptDir });
	const host = registerCompactionHost(api, {
		providers: [conversation],
		expectedOutputTokens: () => 7_700,
		retryPauseMs: 0,
	});
	const outcomes: unknown[] = [];
	events.on(COMPACTION_OUTCOME, (data) => outcomes.push(data));
	const summary = {
		...host,
		prepare: (ctx: ExtensionContext) => host.prepare(ctx, 300_000),
	};
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		let result: unknown;
		for (const h of handlers.get(name) ?? []) result = await h(event, ctx);
		return result;
	};
	return { fire, entries, events, summary, outcomes, conversation };
}

/** Let a summary being written in the background finish. */
export async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The model the session runs on. */
export const model = {
	id: "claude-opus-5-5",
	api: "anthropic-messages",
	provider: "anthropic",
	maxTokens: 128_000,
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/** The fallback entry for a compaction the conversation provider passed on. */
export function fellBack(outcome: "declined" | "failed", reason: string) {
	return [
		SUMMARY_FALLBACK_ENTRY,
		{
			reason,
			attempts: [
				{ provider: "conversation", timing: "on the spot", outcome, reason },
			],
		},
	];
}

/** The branch's one user message. */
export const userEntry = {
	type: "message",
	id: "u1",
	message: {
		role: "user",
		content: [{ type: "text", text: "go" }],
		timestamp: 1,
	},
};
/** The assistant's reply to it. */
export const replyEntry = {
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

/** A session's context on `branch`, its leaf at `leaf`. */
export function context(branch: unknown[], leaf: string | null = "u1") {
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
export function asContext(ctx: ReturnType<typeof context>): ExtensionContext {
	return ctx as unknown as ExtensionContext;
}

/** pi's event asking for a compaction of 300,000 tokens. */
export function compactEvent() {
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

/** The request the session last sent its provider. */
export const sentPayload = {
	model: "claude-opus-5-5",
	system: [{ type: "text", text: "SYSTEM" }],
	messages: [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		{ role: "system", content: [], output_config: { effort: "high" } },
	],
};
