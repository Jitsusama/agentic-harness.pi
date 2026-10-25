/**
 * A Claude plan's two windows, read from what the Claude Code provider
 * said after a turn, and told on the footer.
 */
import { describe, expect, it } from "vitest";
import {
	planUseFrom,
	planUseLine,
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

const clock = (at: number) => new Date(at).toISOString().slice(11, 16);

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

	it("is quiet while there's room in both windows", () => {
		const use = planUseFrom([said()]);
		expect(use && planUseLine(use, clock)).toEqual({
			tone: "dim",
			text: "5h 0% wk 3%",
		});
	});

	it("warns near a window's end, saying when it starts again", () => {
		const use = planUseFrom([
			said(
				{},
				{
					five_hour: { utilization: 0.84, resetsAt: 1792986600 },
					seven_day: { utilization: 0.2, resetsAt: 1792994400 },
				},
			),
		]);
		expect(use && planUseLine(use, clock)).toEqual({
			tone: "warning",
			text: `5h 84% until ${clock(1792986600000)} wk 20%`,
		});
	});

	it("says a refused turn in the error tone, with its reset", () => {
		const use = planUseFrom([
			said(
				{ status: "rejected" },
				{ five_hour: { utilization: 1, resetsAt: 1792986600 } },
			),
		]);
		expect(use && planUseLine(use, clock)).toEqual({
			tone: "error",
			text: `5h 100% until ${clock(1792986600000)}`,
		});
	});
});
