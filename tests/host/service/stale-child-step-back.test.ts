/**
 * A child host rolls at once, rather than at its pace, once its install
 * steps back to a version older than its own, as off a bad release.
 * The pace itself is stale-child.test.ts's.
 */
import { describe, expect, it, vi } from "vitest";
import { rollWhenStale } from "../../../host/service/stale-child.ts";
import { manualTimers } from "./support/manual-timers.ts";

// 27 November (F33): an operator moved the install back off a bad
// release, and each child stayed on it for one to two hours.
describe("rollWhenStale, once the install steps back to a version older than its own", () => {
	it("rolls at its next look, waiting for neither its hour, its spread nor room, saying so", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const reported: unknown[] = [];
		const why = "the install's one changes the host's own code";
		rollWhenStale(async () => why, roll, {
			lookMs: 300_000,
			after: timers.after,
			report: (message) => reported.push(message),
			rollsFrom: 3_600_000,
			now: () => 0,
			spreadMs: 120_000,
			roomShort: async () => "CPU some avg60 was 64.7, at or past 40",
			back: async () => true,
		});
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith(why);
		expect(timers.due, "rolled, it looks no more").toEqual([]);
		expect(reported).toEqual([
			"The install's one changes the host's own code, a step back to a version older than its own, so it rolls now, waiting for neither its hour, its spread nor the machine's room",
		]);
	});

	it("rolls at the look that ends its spread, though the machine is busy", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let back = false;
		rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			report: () => undefined,
			spreadMs: 120_000,
			roomShort: async () => "CPU some avg60 was 50, at or past 40",
			back: async () => back,
		});
		await timers.fire();
		expect(
			timers.due.map(({ ms }) => ms),
			"its spread",
		).toEqual([120_000]);
		back = true;
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
	});

	it("rolls at its next look while the machine is busy", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let back = false;
		rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			report: () => undefined,
			now: () => 0,
			roomShort: async () => "CPU some avg60 was 50, at or past 40",
			back: async () => back,
		});
		await timers.fire();
		expect(roll, "busy").not.toHaveBeenCalled();
		back = true;
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
	});

	it("looks each look within its hour, so it sees a step back at the next, its hour still kept for any other move", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const reported: unknown[] = [];
		let now = 0;
		let back = false;
		rollWhenStale(async () => "moved", roll, {
			lookMs: 300_000,
			after: timers.after,
			report: (message) => reported.push(message),
			rollsFrom: 3_600_000,
			now: () => now,
			back: async () => back,
		});
		now = 300_000;
		await timers.fire();
		expect(roll, "forward, within its hour").not.toHaveBeenCalled();
		expect(
			timers.due.map(({ ms }) => ms),
			"its next look",
		).toEqual([300_000]);
		expect(reported).toEqual([
			"Moved, but it may not roll for 55 minutes yet, unless the install steps back to a version older than its own",
		]);
		now = 3_300_000;
		await timers.fire();
		expect(roll, "still within its hour").not.toHaveBeenCalled();
		expect(
			timers.due.map(({ ms }) => ms),
			"its last look before its hour comes as it is up",
		).toEqual([300_000]);
		now = 3_400_000;
		await timers.fire();
		expect(timers.due.map(({ ms }) => ms)).toEqual([200_000]);
		expect(reported, "said once").toHaveLength(1);
		back = true;
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
	});

	it("keeps today's pace when the install moves anywhere else", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			report: () => undefined,
			now: () => 0,
			spreadMs: 120_000,
			roomShort: async () => undefined,
			back: async () => false,
		});
		await timers.fire();
		expect(roll).not.toHaveBeenCalled();
		expect(
			timers.due.map(({ ms }) => ms),
			"its spread",
		).toEqual([120_000]);
	});

	it("takes a step back it can't tell as none, keeping today's pace", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			report: () => undefined,
			rollsFrom: 3_600_000,
			now: () => 0,
			back: () => Promise.reject(new Error("git timed out")),
		});
		await timers.fire();
		expect(roll, "within its hour").not.toHaveBeenCalled();
		expect(timers.due).toHaveLength(1);
	});

	it("asks whether the install stepped back only once its code moved", async () => {
		const timers = manualTimers();
		const back = vi.fn(async () => true);
		const roll = vi.fn();
		rollWhenStale(async () => undefined, roll, {
			lookMs: 1,
			after: timers.after,
			back,
		});
		await timers.fire();
		expect(back).not.toHaveBeenCalled();
		expect(roll).not.toHaveBeenCalled();
	});

	for (const back of [true, false])
		it(`neither rolls nor looks again once stopped while it asks whether the install stepped back, answered ${back}`, async () => {
			const timers = manualTimers();
			const roll = vi.fn();
			let answer = (_back: boolean): void => undefined;
			const stop = rollWhenStale(async () => "moved", roll, {
				lookMs: 1,
				after: timers.after,
				rollsFrom: 3_600_000,
				now: () => 0,
				back: () =>
					new Promise<boolean>((resolve) => {
						answer = resolve;
					}),
			});
			await timers.fire();
			stop();
			answer(back);
			await new Promise((resolve) => setImmediate(resolve));
			expect(roll).not.toHaveBeenCalled();
			expect(timers.due).toEqual([]);
		});
});
