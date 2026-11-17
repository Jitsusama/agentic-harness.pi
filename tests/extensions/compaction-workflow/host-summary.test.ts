/**
 * The host with the conversation provider alone in its chain: the
 * summary is asked of the conversation the session last sent, sized to
 * what it replaces, with other extensions' focus and appendix, and a
 * verbatim tail that starts on a message. What it does when it can't is
 * in host-hand-back.test.ts, and the files beside it hold the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const { activate, compactEvent, context, replyEntry, sentPayload, userEntry } =
	await import("./host-fixtures.ts");
const { SUMMARY_CONTRIBUTIONS, SUMMARY_SPAN } = await import(
	"../../../lib/compaction/index.ts"
);

describe("the conversation summariser", () => {
	beforeEach(() => {
		completeSimple.mockReset();
	});
	it("summarises from the sent request and returns pi a checkpoint", async () => {
		const { fire, entries } = activate();
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		let sentToProvider: unknown;
		completeSimple.mockImplementation(async (_m, _c, options) => {
			sentToProvider = await options.onPayload({
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
					{ role: "user", content: [{ type: "text", text: "summarise" }] },
				],
			});
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal\nship it" }],
				usage: { input: 10, cacheRead: 290_000 },
			};
		});

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		)) as {
			compaction: Record<string, unknown>;
		};

		expect(result.compaction.summary).toBe(
			`${SUMMARY_SPAN}\n\n## Goal\nship it\n\n<read-files>\na.ts\n</read-files>`,
		);
		expect(result.compaction.firstKeptEntryId).toBe("u1");
		expect(result.compaction.usage).toEqual({ input: 10, cacheRead: 290_000 });
		expect(result.compaction.details).toMatchObject({
			summariser: "conversation",
		});
		expect(sentToProvider).toMatchObject({
			system: sentPayload.system,
			max_tokens: 51_200,
		});
		expect((sentToProvider as { messages: unknown[] }).messages).toHaveLength(
			4,
		);
		expect(entries).toEqual([]);
	});

	it("takes other extensions' focus and appendix, and tells them it wrote the summary", async () => {
		const { fire, events } = activate();
		const seen: Array<{ handled: boolean }> = [];
		events.on(SUMMARY_CONTRIBUTIONS, (data) => {
			const c = data as {
				instructions: string[];
				appendix: string[];
				handled: boolean;
			};
			c.instructions.push("keep the mastery layer");
			c.appendix.push("\n\n## Mastery\nlayer 2");
			seen.push(c);
		});
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		let closing = "";
		completeSimple.mockImplementation(async (_m, c) => {
			closing = JSON.stringify(c.messages.at(-1));
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			};
		});
		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		)) as {
			compaction: { summary: string };
		};
		expect(closing).toContain("Additional focus: keep the mastery layer");
		expect(result.compaction.summary).toBe(
			`${SUMMARY_SPAN}\n\n## Goal\n\n<read-files>\na.ts\n</read-files>\n\n## Mastery\nlayer 2`,
		);
		expect(seen[0]).toMatchObject({ handled: true });
	});

	/** The closing instruction a long conversation is summarised under, in a session of this id. */
	async function closingOfLongSession(sessionId: string): Promise<string> {
		const { fire } = activate();
		// 400,000 characters is 100,000 tokens by pi's estimate; less the
		// 20,000 pi keeps verbatim, the summary replaces about 80,000.
		const long = "x".repeat(400_000);
		const base = context([
			{
				...userEntry,
				message: {
					...userEntry.message,
					content: [{ type: "text", text: long }],
				},
			},
			replyEntry,
		]);
		const ctx = {
			...base,
			sessionManager: { ...base.sessionManager, getSessionId: () => sessionId },
		};
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		let closing = "";
		completeSimple.mockImplementation(async (_m, c) => {
			closing = JSON.stringify(c.messages.at(-1));
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			};
		});
		await fire("session_before_compact", compactEvent(), ctx);
		return closing;
	}

	it("sizes the summary to pi's estimate of what it replaces", async () => {
		// An even last digit puts the session outside the ceiling's trial.
		const closing = await closingOfLongSession("s2");
		expect(closing).toContain("replaces about 80,000 tokens of conversation");
		expect(closing).toContain("Make it about 8,000 tokens long");
		expect(closing).not.toContain("Keep each section concise");
	});

	it("holds a session in the ceiling's trial to the ceiling", async () => {
		const closing = await closingOfLongSession("s1");
		expect(closing).toContain("Keep it to at most 6,000 tokens");
	});

	it("says a focus once when it arrives both by hand and as a contribution", async () => {
		const { fire, events } = activate();
		events.on(SUMMARY_CONTRIBUTIONS, (data) =>
			(data as { instructions: string[] }).instructions.push("keep the layer"),
		);
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		let closing = "";
		completeSimple.mockImplementation(async (_m, c) => {
			closing = JSON.stringify(c.messages.at(-1));
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			};
		});
		await fire(
			"session_before_compact",
			{ ...compactEvent(), customInstructions: "keep the layer" },
			ctx,
		);
		expect(closing.split("keep the layer")).toHaveLength(2);
	});

	it("asks for contributions even when it hands back to pi, leaving them unhandled", async () => {
		const { fire, events } = activate();
		const seen: Array<{ handled: boolean; preparation: object }> = [];
		events.on(SUMMARY_CONTRIBUTIONS, (data) =>
			seen.push(data as { handled: boolean; preparation: object }),
		);
		const event = compactEvent();
		await fire(
			"session_before_compact",
			event,
			context([userEntry, replyEntry]),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ handled: false });
		expect(seen[0]?.preparation).toBe(event.preparation);
	});

	it("never starts the verbatim tail on a custom entry, and tells contributors where it starts", async () => {
		const { fire, events } = activate();
		const seen: Array<{ firstKeptEntryId?: string }> = [];
		events.on(SUMMARY_CONTRIBUTIONS, (data) =>
			seen.push(data as { firstKeptEntryId?: string }),
		);
		const tag = { type: "custom", id: "c1", customType: "tags", data: {} };
		const ctx = context([tag, userEntry, replyEntry], "a1");
		await fire(
			"before_provider_request",
			{ payload: sentPayload },
			context([tag, userEntry], "u1"),
		);
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const event = compactEvent();
		event.preparation.firstKeptEntryId = "c1";
		const result = (await fire("session_before_compact", event, ctx)) as {
			compaction: { firstKeptEntryId: string };
		};
		expect(result.compaction.firstKeptEntryId).toBe("u1");
		expect(seen.map((c) => c.firstKeptEntryId)).toEqual(["u1"]);
	});
});
