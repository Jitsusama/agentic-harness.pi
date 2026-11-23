/** A child host rolls its conversation onto new code once its install moves on. */
import { describe, expect, it, vi } from "vitest";
import { rollWhenStale } from "../../../host/service/stale-child.ts";

// Timers the test fires by hand, each run once.
function manualTimers() {
	const due: { ms: number; run: () => void }[] = [];
	return {
		due,
		after: (ms: number, run: () => void) => {
			const timer = { ms, run };
			due.push(timer);
			return () => {
				const at = due.indexOf(timer);
				if (at >= 0) due.splice(at, 1);
			};
		},
		async fire() {
			const timer = due.shift();
			timer?.run();
			// The look awaits what the install says before it decides.
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

describe("rollWhenStale", () => {
	it("looks each interval and rolls once, saying why, when the install moves on", async () => {
		const timers = manualTimers();
		let moved: string | undefined;
		const roll = vi.fn();
		rollWhenStale(async () => moved, roll, {
			lookMs: 60_000,
			after: timers.after,
		});

		expect(timers.due.map(({ ms }) => ms)).toEqual([60_000]);
		await timers.fire();
		expect(roll, "unmoved").not.toHaveBeenCalled();
		expect(timers.due, "it looks again").toHaveLength(1);

		moved = "the install's two changes the host's own code";
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith(moved);
		expect(
			timers.due,
			"a stale child stays stale, so it stops looking",
		).toEqual([]);
	});

	it("stops looking once told, and a look that throws looks again", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let fail = true;
		const stop = rollWhenStale(
			async () => {
				if (fail) throw new Error("unreadable install");
				return "moved";
			},
			roll,
			{ lookMs: 1, after: timers.after, report: () => undefined },
		);
		await timers.fire();
		expect(roll).not.toHaveBeenCalled();
		expect(timers.due, "a failed look looks again").toHaveLength(1);

		fail = false;
		stop();
		expect(timers.due).toEqual([]);
		expect(roll).not.toHaveBeenCalled();
	});
});
