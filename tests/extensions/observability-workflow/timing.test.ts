/**
 * Each model call's timing and each typed message, kept in the session's
 * log as entries the model is never sent.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CALL_ENTRY,
	TYPED_ENTRY,
	timeCalls,
} from "../../../extensions/observability-workflow/timing.ts";
import {
	type Entry,
	keptView,
} from "../../../lib/internal/session/rollover.ts";

type Handler = (event: unknown) => Promise<unknown>;

/** Just pi's events and appendEntry, with every entry appended. */
function stub() {
	const handlers = new Map<string, Handler[]>();
	const entries: { type: string; data: unknown }[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	};
	const fire = async (event: string, data: unknown) => {
		const answers: unknown[] = [];
		for (const handler of handlers.get(event) ?? [])
			answers.push(await handler(data));
		return answers;
	};
	timeCalls(pi as unknown as ExtensionAPI);
	return { entries, fire };
}

/** An assistant message as pi finishes one. */
function assistant(
	timestamp: number,
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp,
		...extra,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

// 7QEY1S, 12 November: the log says when a call's request started and
// how long it ran, but not when its first token came, nor which user
// messages were typed.
describe("a model call's timing in the log", () => {
	it("says how long the harness took to ask, and the first token and whole call took", async () => {
		vi.useFakeTimers({ now: new Date("2026-11-12T07:00:00.000Z") });
		const { entries, fire } = stub();

		await fire("turn_start", { type: "turn_start" });
		const asked = Date.now() + 120;
		vi.setSystemTime(asked + 900);
		const streaming = { role: "assistant" };
		await fire("message_update", { message: streaming });
		vi.setSystemTime(asked + 1500);
		await fire("message_update", { message: streaming });
		await fire("message_end", {
			message: assistant(asked, { durationMs: 4200 }),
		});

		expect(entries, "one entry, naming the call by its request").toEqual([
			{
				type: CALL_ENTRY,
				data: {
					v: 1,
					of: asked,
					turnAt: "2026-11-12T07:00:00.000Z",
					preparedMs: 120,
					firstTokenMs: 900,
					durationMs: 4200,
					stopReason: "stop",
				},
			},
		]);
	});

	it("times each call of a turn once, and leaves out what it never saw", async () => {
		const { entries, fire } = stub();

		await fire("message_end", { message: assistant(Date.now()) });
		await fire("turn_start", { type: "turn_start" });
		await fire("message_end", { message: { role: "user", content: "hi" } });
		await fire("message_end", { message: assistant(Date.now()) });
		await fire("message_end", { message: assistant(Date.now()) });

		expect(entries.length, "only the call its turn began").toBe(1);
		expect(entries[0]?.data, "no first token, no duration").not.toHaveProperty(
			"firstTokenMs",
		);
		expect(
			entries[0]?.data,
			"no duration pi didn't measure",
		).not.toHaveProperty("durationMs");
	});
});

describe("a typed message in the log", () => {
	it("marks what the person typed, with how it was queued, and never an extension's", async () => {
		vi.useFakeTimers({ now: new Date("2026-11-12T07:05:00.000Z") });
		const { entries, fire } = stub();

		const answers = [
			...(await fire("input", {
				type: "input",
				text: "keep it",
				source: "interactive",
			})),
			...(await fire("input", {
				type: "input",
				text: "and shorter",
				source: "interactive",
				streamingBehavior: "steer",
			})),
			...(await fire("input", {
				type: "input",
				text: "[From the mesh]",
				source: "extension",
			})),
		];

		expect(entries, "two typed, the extension's left out").toEqual([
			{
				type: TYPED_ENTRY,
				data: {
					v: 1,
					at: "2026-11-12T07:05:00.000Z",
					source: "interactive",
					chars: 7,
				},
			},
			{
				type: TYPED_ENTRY,
				data: {
					v: 1,
					at: "2026-11-12T07:05:00.000Z",
					source: "interactive",
					queued: "steer",
					chars: 11,
				},
			},
		]);
		expect(answers, "every message goes on as typed").toEqual([
			{ action: "continue" },
			{ action: "continue" },
			{ action: "continue" },
		]);
	});
});

// Nothing in the process reads either entry back; the latency pass reads
// the log on disk. Held from before the last compaction they cost a long
// conversation 2.1 MB of its kept view (a 68 MB log, 7,068 call entries).
describe("timing entries in a kept view", () => {
	it("stay behind with the turns they time, while other state is kept", () => {
		stub();
		const at = "2026-11-12T07:00:00.000Z";
		const custom = (id: string, parentId: string, customType: string) => ({
			type: "custom",
			id,
			parentId,
			timestamp: at,
			customType,
			data: {},
		});
		const message = (id: string, parentId: string | null) => ({
			type: "message",
			id,
			parentId,
			timestamp: at,
			message: { role: "user", content: "hi", timestamp: 0 },
		});
		const branch = [
			message("a0000001", null),
			custom("a0000002", "a0000001", TYPED_ENTRY),
			custom("a0000003", "a0000002", CALL_ENTRY),
			custom("a0000004", "a0000003", "some-state"),
			message("a0000005", "a0000004"),
			{
				type: "compaction",
				id: "a0000006",
				parentId: "a0000005",
				timestamp: at,
				summary: "so far",
				firstKeptEntryId: "a0000005",
				tokensBefore: 10,
			},
		] as unknown as Entry[];

		const kept = keptView(branch)?.entries.map((entry) => entry.id);

		expect(kept, "the state, then the turn kept and its compaction").toEqual([
			"a0000004",
			"a0000005",
			"a0000006",
		]);
	});
});
