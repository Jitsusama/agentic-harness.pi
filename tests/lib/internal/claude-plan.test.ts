/**
 * A Claude plan's two windows, read from what the Claude Code provider
 * said after a turn.
 */
import { describe, expect, it } from "vitest";
import {
	lastPlanUse,
	PLAN_PROVIDER,
	planUseFrom,
	planUseOf,
	RATE_LIMIT,
} from "../../../lib/internal/claude-plan.ts";

/** As the provider wrote it on optimus, 2026-10-25. */
function said(over: Record<string, unknown> = {}, windows?: unknown) {
	return {
		type: RATE_LIMIT,
		details: {
			status: "allowed",
			isUsingOverage: false,
			unifiedWindows: windows ?? {
				five_hour: { utilization: 0, resetsAt: 1792986600 },
				seven_day: { utilization: 0.03, resetsAt: 1792994400 },
			},
			...over,
		},
	};
}

/** An assistant message as pi logs it. */
function reply(provider: string, diagnostics: unknown[] = [said()]) {
	return { role: "assistant", provider, diagnostics };
}

describe("a Claude plan's use", () => {
	it("reads both windows, resets in milliseconds", () => {
		expect(planUseFrom([{ type: "claude-code.turn-relay" }, said()])).toEqual({
			fiveHour: { used: 0, resets: 1792986600000 },
			week: { used: 0.03, resets: 1792994400000 },
			stopped: false,
		});
	});

	it("takes the last said, and nothing from a message that said none", () => {
		const later = said({}, { five_hour: { utilization: 0.5 } });
		expect(planUseFrom([said(), later])?.fiveHour).toEqual({ used: 0.5 });
		expect(planUseFrom([{ type: "claude-code.turn-relay" }])).toBeUndefined();
		expect(planUseFrom(undefined)).toBeUndefined();
		expect(planUseFrom([said({}, {})])).toBeUndefined();
	});

	it("says a refused turn stopped", () => {
		expect(planUseFrom([said({ status: "rejected" })])?.stopped).toBe(true);
	});
});

describe("the plan's use in a session", () => {
	it("is read only from Claude Code's replies", () => {
		expect(planUseOf(reply(PLAN_PROVIDER))?.week).toEqual({
			used: 0.03,
			resets: 1792994400000,
		});
		expect(planUseOf(reply("anthropic"))).toBeUndefined();
		expect(
			planUseOf({ role: "user", provider: PLAN_PROVIDER }),
		).toBeUndefined();
		expect(
			planUseOf(reply(PLAN_PROVIDER, ["not a diagnostic"])),
		).toBeUndefined();
	});

	it("is the newest the branch holds", () => {
		const newer = said({}, { five_hour: { utilization: 0.7 } });
		const branch = [
			{ type: "message", message: reply(PLAN_PROVIDER) },
			{ type: "message", message: reply(PLAN_PROVIDER, [newer]) },
			{ type: "custom" },
			{ type: "message", message: { role: "user" } },
		];
		expect(lastPlanUse(branch)?.fiveHour).toEqual({ used: 0.7 });
		expect(lastPlanUse([{ type: "custom" }])).toBeUndefined();
	});
});
