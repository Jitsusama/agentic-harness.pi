/**
 * The host trusting the cached conversation only while it may still be
 * warm: past its retention it hands back to pi, and a warm that
 * refreshed the request's entry keeps it usable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const { activate, compactEvent, context, replyEntry, sentPayload, userEntry } =
	await import("./host-fixtures.ts");

describe("the conversation summariser", () => {
	beforeEach(() => {
		completeSimple.mockReset();
	});
	it.each([
		["short", undefined, 5 * 60_000],
		["long", "long", 60 * 60_000],
	])(
		"hands back to pi once a %s-retention cache may have expired",
		async (_name, retention, lifetime) => {
			vi.useFakeTimers();
			vi.stubEnv("PI_CACHE_RETENTION", retention);
			try {
				const { fire, entries } = activate();
				const ctx = context([userEntry, replyEntry]);
				await fire("before_provider_request", { payload: sentPayload }, ctx);
				vi.advanceTimersByTime(lifetime);
				expect(
					await fire("session_before_compact", compactEvent(), ctx),
				).toBeUndefined();
				expect(entries[0]?.[1]).toMatchObject({
					reason: "the cached conversation may have expired",
				});
			} finally {
				vi.useRealTimers();
				vi.unstubAllEnvs();
			}
		},
	);

	it("summarises from the cache past the hour when a warm refreshed it, and only that request's", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_CACHE_RETENTION", "long");
		try {
			const { fire, entries, conversation } = activate();
			const ctx = context([userEntry, replyEntry]);
			await fire("before_provider_request", { payload: sentPayload }, ctx);
			vi.advanceTimersByTime(54 * 60_000);
			conversation.refreshed(sentPayload, Date.now());
			// Another request's refresh says nothing about this one's entry.
			conversation.refreshed({ ...sentPayload }, Date.now() + 10 * 60_000);
			vi.advanceTimersByTime(54 * 60_000);
			completeSimple.mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			});

			const result = await fire("session_before_compact", compactEvent(), ctx);
			expect(result).toMatchObject({
				compaction: { details: { summariser: "conversation" } },
			});
			vi.advanceTimersByTime(6 * 60_000);
			expect(
				await fire("session_before_compact", compactEvent(), ctx),
			).toBeUndefined();
			expect(entries[0]?.[1]).toMatchObject({
				reason: "the cached conversation may have expired",
			});
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
		}
	});
});
