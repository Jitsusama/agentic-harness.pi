import { describe, expect, it } from "vitest";
import {
	cacheLifetimeOf,
	prefixMissed,
	replayable,
	warmDeadline,
	warmingDelayMs,
	warmingPayload,
} from "../../../lib/internal/cache-warming.ts";

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

const marked = (cache_control: unknown) => ({
	type: "text",
	text: "x",
	cache_control,
});

describe("how long a request's cache entry lives", () => {
	it("is an hour when any marker asks for one", () => {
		expect(
			cacheLifetimeOf({
				system: [marked({ type: "ephemeral" })],
				messages: [
					{
						role: "user",
						content: [marked({ type: "ephemeral", ttl: "1h" })],
					},
				],
			}),
		).toBe(HOUR);
	});

	it("is Anthropic's five minutes for markers with no lifetime", () => {
		expect(cacheLifetimeOf({ tools: [marked({ type: "ephemeral" })] })).toBe(
			5 * MINUTE,
		);
	});

	it("is nothing for a request that asked for no cache", () => {
		expect(
			cacheLifetimeOf({ messages: [{ role: "user", content: "hi" }] }),
		).toBeUndefined();
		expect(cacheLifetimeOf(undefined)).toBeUndefined();
	});
});

describe("when a warm falls due", () => {
	it("is nine tenths of an hour, 54 minutes", () => {
		expect(warmingDelayMs(HOUR)).toBe(54 * MINUTE);
	});

	it("keeps ten seconds before expiry when nine tenths would not", () => {
		expect(warmingDelayMs(60_000)).toBe(50_000);
		expect(warmingDelayMs(10_000)).toBeUndefined();
	});

	it("may run late by half of what was left before expiry, three minutes for an hour", () => {
		expect(warmDeadline(1_000, HOUR)).toBe(1_000 + 3 * MINUTE);
	});
});

describe("whether a request can be sent again to warm it", () => {
	it("can with adaptive thinking or none", () => {
		expect(
			replayable({ thinking: { type: "adaptive" } }, "anthropic-messages"),
		).toEqual({ ok: true });
		expect(
			replayable({ thinking: { type: "disabled" } }, "anthropic-messages"),
		).toEqual({ ok: true });
		expect(replayable({}, "anthropic-messages")).toEqual({ ok: true });
	});

	it("cannot with budget-based thinking, whose budget follows the cap", () => {
		expect(
			replayable(
				{ thinking: { type: "enabled", budget_tokens: 4_096 } },
				"anthropic-messages",
			),
		).toMatchObject({ ok: false });
	});

	it("cannot on any other API, whose request shape is not read", () => {
		expect(replayable({}, "openai-responses")).toEqual({
			ok: false,
			reason: "the openai-responses API is not supported",
		});
	});
});

describe("the warm itself", () => {
	it("is the same request with a one-token cap", () => {
		const request = { model: "m", max_tokens: 64_000, messages: [] };
		expect(warmingPayload(request)).toEqual({ ...request, max_tokens: 1 });
		expect(request.max_tokens).toBe(64_000);
	});

	it("missed its prefix when it wrote more than 2,000 tokens", () => {
		expect(
			prefixMissed({ cacheWrite: 2_000 }),
			"writing exactly 2,000 tokens is no miss",
		).toBe(false);
		expect(
			prefixMissed({ cacheWrite: 2_001 }),
			"writing 2,001 tokens missed the prefix",
		).toBe(true);
		expect(prefixMissed({}), "a reply that wrote nothing is no miss").toBe(
			false,
		);
	});
});
