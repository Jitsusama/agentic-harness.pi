/**
 * Usage: what a session's model calls took, counted for its presence.
 */
import { describe, expect, it } from "vitest";
import {
	type CallMessage,
	carriedUsage,
	isUsage,
	localDay,
	noUsage,
	usageFromLog,
	withCall,
} from "../../../lib/mesh/usage.ts";

const call = (over: Partial<CallMessage> = {}): CallMessage => ({
	role: "assistant",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: {
		input: 10,
		output: 200,
		cacheRead: 90_000,
		cacheWrite: 1_500,
		cost: { total: 0.25 },
	},
	...over,
});

describe("a session's usage", () => {
	const evening = new Date("2026-11-06T22:00:00");

	it("counts a call under gen_ai's names, as its last and into today", () => {
		const usage = withCall(noUsage(localDay(evening)), call(), {
			at: evening,
			startedAt: evening.getTime() - 4_000,
			firstTokenAt: evening.getTime() - 3_100,
			context: { used: 91_510, limit: 200_000 },
		});
		const again = withCall(
			usage,
			call({ responseModel: "claude-opus-5-5-20261101" }),
			{ at: evening },
		);

		expect(usage).toEqual({
			day: "2026-11-06",
			"gen_ai.request.model": "claude-opus-5-5",
			"gen_ai.response.model": "claude-opus-5-5",
			"gen_ai.provider.name": "anthropic",
			last: {
				"gen_ai.usage.input_tokens": 10,
				"gen_ai.usage.output_tokens": 200,
				"gen_ai.usage.cache_read.input_tokens": 90_000,
				"gen_ai.usage.cache_creation.input_tokens": 1_500,
			},
			today: {
				"gen_ai.usage.input_tokens": 10,
				"gen_ai.usage.output_tokens": 200,
				"gen_ai.usage.cache_read.input_tokens": 90_000,
				"gen_ai.usage.cache_creation.input_tokens": 1_500,
			},
			context: { used: 91_510, limit: 200_000 },
			turns: {
				today: 1,
				last: {
					at: evening.toISOString(),
					duration_ms: 4_000,
					first_token_ms: 900,
				},
			},
			"pi.cost.usd": { last: 0.25, today: 0.25 },
		});
		expect(again).toMatchObject({
			"gen_ai.response.model": "claude-opus-5-5-20261101",
			today: { "gen_ai.usage.output_tokens": 400 },
			turns: { today: 2 },
			"pi.cost.usd": { last: 0.25, today: 0.5 },
		});
	});

	it("starts today afresh once the day turns", () => {
		const late = withCall(noUsage(localDay(evening)), call(), { at: evening });

		const next = withCall(late, call(), {
			at: new Date("2026-11-07T00:00:05"),
		});

		expect(next).toMatchObject({
			day: "2026-11-07",
			turns: { today: 1 },
			"pi.cost.usd": { today: 0.25 },
			today: { "gen_ai.usage.output_tokens": 200 },
		});
	});

	it("counts nothing for a message that is not a model call's", () => {
		const usage = noUsage(localDay(evening));

		expect(withCall(usage, { role: "user" }, { at: evening })).toBe(usage);
		expect(withCall(usage, call({ usage: undefined }), { at: evening })).toBe(
			usage,
		);
	});

	it("counts a session's own log from local midnight", () => {
		const logged = (timestamp: string, message: unknown) => ({
			type: "message",
			timestamp,
			message,
		});
		const entries = [
			logged(new Date("2026-11-05T23:59:00").toISOString(), call()),
			logged(new Date("2026-11-06T08:00:00").toISOString(), call()),
			{ type: "compaction", timestamp: new Date().toISOString() },
			logged(new Date("2026-11-06T09:00:00").toISOString(), {
				role: "user",
				content: "hi",
			}),
			logged(new Date("2026-11-06T21:00:00").toISOString(), call()),
		];

		expect(usageFromLog(entries, evening)).toMatchObject({
			day: "2026-11-06",
			turns: { today: 2 },
			"pi.cost.usd": { today: 0.5 },
			today: { "gen_ai.usage.cache_read.input_tokens": 180_000 },
		});
	});

	it("is carried in whole for today, and only when it reads", () => {
		const today = withCall(noUsage(localDay(evening)), call(), {
			at: evening,
		});

		expect(carriedUsage(today, evening)).toEqual(today);
		expect(carriedUsage({ day: "2026-11-06" }, evening)).toBeUndefined();
		expect(
			isUsage(JSON.parse(JSON.stringify(today))),
			"the carried usage reads back from JSON",
		).toBe(true);
	});

	it("keeps its last call past midnight, with today's counts started afresh", () => {
		// 02:36 on 9 November: a session reloaded after midnight said no last
		// turn, and was read as idle since it began (80ECO2 [800fe3db]).
		const yesterday = withCall(noUsage(localDay(evening)), call(), {
			at: evening,
			startedAt: evening.getTime() - 4000,
		});

		const carried = carriedUsage(yesterday, new Date("2026-11-07T02:36:00"));

		expect(carried).toEqual({
			...noUsage("2026-11-07"),
			"gen_ai.request.model": "claude-opus-5-5",
			"gen_ai.response.model": "claude-opus-5-5",
			"gen_ai.provider.name": "anthropic",
			turns: {
				today: 0,
				last: { at: evening.toISOString(), duration_ms: 4000 },
			},
		});
	});
});
