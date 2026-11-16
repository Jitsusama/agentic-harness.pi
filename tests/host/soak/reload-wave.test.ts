/**
 * A wave of reloads is weighed reload by reload: the first, which loads
 * the new version's code, apart from the rest, which find it loaded, and
 * every reload whose loop hold passes item 9's bar counted.
 */
import { describe, expect, it } from "vitest";
import { LOOP_BAR_MS, waveCheckpoint, waveOf } from "./reload-wave.ts";

describe("a reload wave", () => {
	it("runs three quarters through a run's checkpoints", () => {
		expect(waveCheckpoint(24), "a volume run's 24").toBe(18);
		expect(waveCheckpoint(2), "a paced run's 2").toBe(2);
		expect(waveCheckpoint(1), "a run of one").toBe(1);
	});

	it("weighs its first reload apart from the rest", () => {
		const figures = waveOf([
			{ conversation: 0, ms: 2400, loopMaxMs: 1800 },
			{ conversation: 1, ms: 400, loopMaxMs: 120 },
			{ conversation: 2, ms: 600, loopMaxMs: 300 },
		]);
		expect(figures).toEqual({
			count: 3,
			first: { ms: 2400, loopMaxMs: 1800 },
			rest: {
				ms: { count: 2, p50: 400, p99: 600 },
				loopMaxMs: { count: 2, p50: 120, p99: 300 },
				mostLoopMaxMs: 300,
			},
			overBar: 1,
		});
	});

	it("counts every reload past the bar, the first and the rest", () => {
		const over = LOOP_BAR_MS + 1;
		const figures = waveOf([
			{ conversation: 0, ms: 2000, loopMaxMs: over },
			{ conversation: 1, ms: 2000, loopMaxMs: over },
			{ conversation: 2, ms: 500, loopMaxMs: LOOP_BAR_MS },
		]);
		expect(figures.overBar, "a hold at the bar isn't over it").toBe(2);
		expect(figures.rest.mostLoopMaxMs, "the rest's worst").toBe(over);
	});

	it("says no first reload when none ran", () => {
		const figures = waveOf([]);
		expect(figures.count, "no reloads").toBe(0);
		expect(figures.first, "no first").toBe(undefined);
		expect(figures.rest.mostLoopMaxMs, "nothing held").toBe(0);
	});
});
