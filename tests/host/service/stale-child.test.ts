/**
 * A child host rolls its conversation onto new code once its install moves
 * on: when it looks, what it says, and when it may roll. The child's wiring
 * of it is stale-child-wiring.test.ts's.
 */
import { describe, expect, it, vi } from "vitest";
import { rollWhenStale } from "../../../host/service/stale-child.ts";
import { manualTimers } from "./support/manual-timers.ts";

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
		const reported: unknown[] = [];
		const stop = rollWhenStale(
			async () => {
				if (fail) throw new Error("unreadable install");
				return "moved";
			},
			roll,
			{
				lookMs: 1,
				after: timers.after,
				report: (message) => reported.push(message),
			},
		);
		await timers.fire();
		expect(roll).not.toHaveBeenCalled();
		expect(timers.due, "a failed look looks again").toHaveLength(1);
		expect(reported).toEqual([
			"Couldn't tell whether the install's host code moved on, so it looks again: unreadable install",
		]);

		fail = false;
		const [again] = timers.due;
		stop();
		expect(timers.due, "its next look let go").toEqual([]);
		// As a timer that fires as it is let go: stopped, it rolls nothing.
		again?.run();
		await new Promise((resolve) => setImmediate(resolve));
		expect(roll).not.toHaveBeenCalled();
	});

	it("says once that it couldn't tell while the install stays unreadable, and again once it answered between", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let answer: () => string | undefined = () => {
			throw new Error("unreadable install");
		};
		const reported: unknown[] = [];
		rollWhenStale(async () => answer(), roll, {
			lookMs: 1,
			after: timers.after,
			report: (message) => reported.push(message),
		});
		await timers.fire();
		await timers.fire();
		await timers.fire();
		expect(reported, "the same doubt, said once").toEqual([
			"Couldn't tell whether the install's host code moved on, so it looks again: unreadable install",
		]);

		answer = () => {
			throw new Error("link can't be read");
		};
		await timers.fire();
		answer = () => undefined;
		await timers.fire();
		answer = () => {
			throw new Error("link can't be read");
		};
		await timers.fire();
		expect(
			reported,
			"a new doubt is said, its end is said, and an old one again after a look that answered",
		).toEqual([
			"Couldn't tell whether the install's host code moved on, so it looks again: unreadable install",
			"Couldn't tell whether the install's host code moved on, so it looks again: link can't be read",
			"It can tell again whether the install's host code moved on",
			"Couldn't tell whether the install's host code moved on, so it looks again: link can't be read",
		]);
		expect(roll).not.toHaveBeenCalled();
	});

	it("ends a doubt at a look that finds the code moved, saying so, and says the doubt again after it", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let answer: () => string | undefined = () => {
			throw new Error("unreadable install");
		};
		const reported: unknown[] = [];
		rollWhenStale(async () => answer(), roll, {
			lookMs: 1,
			after: timers.after,
			report: (message) => reported.push(message),
			now: () => 0,
			// Too soon to roll, so a look that finds the code moved only says so.
			rollsFrom: 60_000,
		});
		await timers.fire();
		answer = () => "the install moved on";
		await timers.fire();
		answer = () => {
			throw new Error("unreadable install");
		};
		await timers.fire();
		expect(reported).toEqual([
			"Couldn't tell whether the install's host code moved on, so it looks again: unreadable install",
			"It can tell again whether the install's host code moved on",
			"The install moved on, but it may not roll yet, so it looks again in a minute",
			"Couldn't tell whether the install's host code moved on, so it looks again: unreadable install",
		]);
		expect(roll).not.toHaveBeenCalled();
	});

	it("rolls at the look after one that threw, once the install answers", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let fail = true;
		rollWhenStale(
			async () => {
				if (fail) throw new Error("unreadable install");
				return "moved";
			},
			roll,
			{ lookMs: 1, after: timers.after, report: () => undefined },
		);
		await timers.fire();
		fail = false;
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
		expect(timers.due, "rolled, it looks no more").toEqual([]);
	});

	it("rolls not once stopped while a look is under way, though that look finds the code stale", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let answer = (_why: string | undefined): void => undefined;
		const stop = rollWhenStale(
			() =>
				new Promise<string | undefined>((resolve) => {
					answer = resolve;
				}),
			roll,
			{ lookMs: 1, after: timers.after },
		);
		await timers.fire();
		stop();
		answer("moved");
		// The look awaits what the install says before it decides.
		await new Promise((resolve) => setImmediate(resolve));
		expect(roll, "the child stopped, as it exits").not.toHaveBeenCalled();
		expect(timers.due, "nor does it look again").toEqual([]);
	});

	it("puts a roll off until it may roll, then looks again before it rolls", async () => {
		const timers = manualTimers();
		let now = 1_000;
		let moved: string | undefined = "the install's two changes the host's code";
		const roll = vi.fn();
		const reported: unknown[] = [];
		rollWhenStale(async () => moved, roll, {
			lookMs: 60_000,
			after: timers.after,
			report: (message) => reported.push(message),
			rollsFrom: 1_000 + 3_600_000,
			now: () => now,
		});

		now += 60_000;
		await timers.fire();
		expect(roll, "too young to roll").not.toHaveBeenCalled();
		expect(
			timers.due.map(({ ms }) => ms),
			"it looks again once it may roll, not before",
		).toEqual([3_540_000]);
		expect(reported).toEqual([
			"The install's two changes the host's code, but it may not roll yet, so it looks again in 59 minutes",
		]);

		now += 3_540_000;
		moved = "the install's three changes the host's code";
		await timers.fire();
		expect(
			roll,
			"with what the install says then",
		).toHaveBeenCalledExactlyOnceWith(moved);
		expect(timers.due).toEqual([]);
	});

	it("says once that it may not roll yet, though it looks again early", async () => {
		const timers = manualTimers();
		const reported: unknown[] = [];
		rollWhenStale(async () => "moved", vi.fn(), {
			lookMs: 1,
			after: timers.after,
			report: (message) => reported.push(message),
			rollsFrom: 3_600_000,
			// A clock that hasn't moved when its timer fires, as one put back.
			now: () => 0,
		});
		await timers.fire();
		await timers.fire();
		expect(reported).toEqual([
			"Moved, but it may not roll yet, so it looks again in 60 minutes",
		]);
	});

	it("says once that it may not roll yet, though a look between couldn't tell", async () => {
		const timers = manualTimers();
		const reported: unknown[] = [];
		const answers = ["moved", new Error("link can't be read"), "moved"];
		rollWhenStale(
			async () => {
				const answer = answers.shift();
				if (answer instanceof Error) throw answer;
				return answer;
			},
			vi.fn(),
			{
				lookMs: 1,
				after: timers.after,
				report: (message) => reported.push(message),
				rollsFrom: 3_600_000,
				now: () => 0,
			},
		);
		await timers.fire();
		await timers.fire();
		await timers.fire();
		expect(reported).toEqual([
			"Moved, but it may not roll yet, so it looks again in 60 minutes",
			"Couldn't tell whether the install's host code moved on, so it looks again: link can't be read",
			"It can tell again whether the install's host code moved on",
		]);
	});

	it("says nothing of the code being current when it waited for nothing", async () => {
		const timers = manualTimers();
		const reported: unknown[] = [];
		rollWhenStale(async () => undefined, vi.fn(), {
			lookMs: 1,
			after: timers.after,
			report: (message) => reported.push(message),
			now: () => 0,
		});
		await timers.fire();
		await timers.fire();
		expect(reported).toEqual([]);
	});

	it("waits its spread after its hour, not within it", async () => {
		const timers = manualTimers();
		let now = 0;
		const roll = vi.fn();
		rollWhenStale(async () => "moved", roll, {
			lookMs: 60_000,
			after: timers.after,
			report: () => undefined,
			rollsFrom: 3_600_000,
			now: () => now,
			spreadMs: 120_000,
			roomShort: async () => undefined,
		});
		now = 60_000;
		await timers.fire();
		expect(timers.due.map(({ ms }) => ms)).toEqual([3_540_000]);
		now = 3_600_000;
		await timers.fire();
		expect(roll, "its hour is up, but not its spread").not.toHaveBeenCalled();
		expect(timers.due.map(({ ms }) => ms)).toEqual([120_000]);
		now += 120_000;
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
	});

	it("waits its spread again after the machine was busy, so the children held go out apart", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const reported: unknown[] = [];
		let short: string | undefined = "CPU some avg60 was 64.7, at or past 40";
		rollWhenStale(async () => "moved", roll, {
			lookMs: 300_000,
			after: timers.after,
			report: (message) => reported.push(message),
			now: () => 0,
			spreadMs: 120_000,
			roomShort: async () => short,
		});
		await timers.fire();
		await timers.fire();
		expect(
			timers.due.map(({ ms }) => ms),
			"busy: it looks again",
		).toEqual([300_000]);
		expect(reported).toEqual([
			"Moved, but the machine is busy (CPU some avg60 was 64.7, at or past 40), so it looks again each 7 minutes until it has room, rolling anyway at its first look past 60 minutes",
		]);
		short = undefined;
		await timers.fire();
		expect(roll, "room now, but its spread comes first").not.toHaveBeenCalled();
		expect(timers.due.map(({ ms }) => ms)).toEqual([120_000]);
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
	});

	it("forgets its wait for room once the install's code is current again", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const reported: unknown[] = [];
		let now = 0;
		let moved: string | undefined = "moved";
		rollWhenStale(async () => moved, roll, {
			lookMs: 1,
			after: timers.after,
			report: (message) => reported.push(message),
			now: () => now,
			roomShort: async () => "CPU some avg60 was 50, at or past 40",
			waitsForRoomAtMostMs: 600_000,
		});
		await timers.fire();
		now = 500_000;
		moved = undefined;
		await timers.fire();
		now = 600_000;
		moved = "moved again";
		await timers.fire();
		expect(roll, "its wait began again").not.toHaveBeenCalled();
		expect(reported).toHaveLength(3);
		expect(reported[1], "it says it forgot its wait").toBe(
			"The install's host code is current again, so it no longer waits to roll",
		);
		expect(reported[2]).toMatch(/^Moved again, but the machine is busy/);
	});

	it("keeps its wait for room through a look that couldn't tell, so its most still bounds it", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const reported: unknown[] = [];
		let now = 0;
		let fails = false;
		rollWhenStale(
			async () => {
				if (fails) throw new Error("EIO");
				return "moved";
			},
			roll,
			{
				lookMs: 1,
				after: timers.after,
				report: (message) => reported.push(message),
				now: () => now,
				roomShort: async () => "CPU some avg60 was 50, at or past 40",
				waitsForRoomAtMostMs: 600_000,
			},
		);
		await timers.fire();
		now = 300_000;
		fails = true;
		await timers.fire();
		now = 600_000;
		fails = false;
		await timers.fire();
		expect(
			roll,
			"ten minutes since it first found no room, the throw between",
		).toHaveBeenCalledExactlyOnceWith("moved");
		expect(
			reported.filter((said) => String(said).startsWith("Moved, but")),
			"it said it was busy once, not again after the throw",
		).toHaveLength(1);
	});

	it("spreads again once the install's code was current between two moves", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let moved: string | undefined = "moved";
		rollWhenStale(async () => moved, roll, {
			lookMs: 1,
			after: timers.after,
			spreadMs: 120_000,
			roomShort: async () => undefined,
		});
		await timers.fire();
		expect(
			timers.due.map(({ ms }) => ms),
			"its spread",
		).toEqual([120_000]);
		moved = undefined;
		await timers.fire();
		moved = "moved again";
		await timers.fire();
		expect(roll, "a new move waits its share again").not.toHaveBeenCalled();
		expect(timers.due.map(({ ms }) => ms)).toEqual([120_000]);
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved again");
	});

	it("says again that it may not roll yet once the code was current between two moves", async () => {
		const timers = manualTimers();
		const reported: unknown[] = [];
		let moved: string | undefined = "moved";
		rollWhenStale(async () => moved, vi.fn(), {
			lookMs: 1,
			after: timers.after,
			report: (message) => reported.push(message),
			rollsFrom: 600_000,
			now: () => 0,
		});
		await timers.fire();
		moved = undefined;
		await timers.fire();
		moved = "moved again";
		await timers.fire();
		expect(reported).toEqual([
			"Moved, but it may not roll yet, so it looks again in 10 minutes",
			"The install's host code is current again, so it no longer waits to roll",
			"Moved again, but it may not roll yet, so it looks again in 10 minutes",
		]);
	});

	it("rolls at once when the install moves on after it may roll", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			rollsFrom: 5_000,
			now: () => 5_000,
		});
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
	});

	it("waits its spread once it may roll, then rolls", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		rollWhenStale(async () => "moved", roll, {
			lookMs: 60_000,
			after: timers.after,
			spreadMs: 120_000,
			roomShort: async () => undefined,
		});
		await timers.fire();
		expect(
			roll,
			"spread, so a machine's children roll apart",
		).not.toHaveBeenCalled();
		expect(timers.due.map(({ ms }) => ms)).toEqual([120_000]);
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
		expect(timers.due, "rolled, it looks no more").toEqual([]);
	});

	it("keeps the spread it waited through a look that couldn't tell, so it rolls at the next that answers", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const answers: (() => string)[] = [
			() => "moved",
			() => {
				throw new Error("link can't be read");
			},
		];
		rollWhenStale(async () => (answers.shift() ?? (() => "moved"))(), roll, {
			lookMs: 60_000,
			after: timers.after,
			spreadMs: 120_000,
			roomShort: async () => undefined,
			report: () => undefined,
		});
		await timers.fire();
		expect(
			timers.due.map(({ ms }) => ms),
			"its spread",
		).toEqual([120_000]);
		await timers.fire();
		expect(
			timers.due.map(({ ms }) => ms),
			"couldn't tell",
		).toEqual([60_000]);
		await timers.fire();
		expect(roll, "its spread already waited").toHaveBeenCalledExactlyOnceWith(
			"moved",
		);
	});

	it("rolls only while the machine has room, saying once why it waits", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const reported: unknown[] = [];
		let short: string | undefined = "CPU some avg60 was 64.7, at or past 40";
		let now = 0;
		rollWhenStale(async () => "the host's code differs", roll, {
			lookMs: 300_000,
			after: timers.after,
			report: (message) => reported.push(message),
			now: () => now,
			roomShort: async () => short,
		});
		await timers.fire();
		now += 300_000;
		await timers.fire();
		expect(roll, "busy").not.toHaveBeenCalled();
		expect(
			timers.due.map(({ ms }) => ms),
			"it looks again each look",
		).toEqual([300_000]);
		expect(reported).toEqual([
			"The host's code differs, but the machine is busy (CPU some avg60 was 64.7, at or past 40), so it looks again each 5 minutes until it has room, rolling anyway at its first look past 60 minutes",
		]);

		short = undefined;
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("the host's code differs");
		expect(timers.due).toEqual([]);
	});

	it("rolls anyway once it has waited its most for room, saying so", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		const reported: unknown[] = [];
		let now = 0;
		rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			report: (message) => reported.push(message),
			now: () => now,
			roomShort: async () => "CPU some avg60 was 50, at or past 40",
			waitsForRoomAtMostMs: 600_000,
		});
		await timers.fire();
		now += 599_999;
		await timers.fire();
		expect(roll, "a moment short of its most").not.toHaveBeenCalled();
		now += 1;
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
		expect(reported.at(-1)).toBe(
			"It waited 10 minutes for the machine's room, so it rolls though the machine is busy (CPU some avg60 was 50, at or past 40)",
		);
	});

	it("takes a room it can't read as room, and rolls", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			roomShort: () => Promise.reject(new Error("no pressure file")),
		});
		await timers.fire();
		expect(roll).toHaveBeenCalledExactlyOnceWith("moved");
	});

	it("rolls not once stopped while it asks for room", async () => {
		const timers = manualTimers();
		const roll = vi.fn();
		let answer = (_short: string | undefined): void => undefined;
		const stop = rollWhenStale(async () => "moved", roll, {
			lookMs: 1,
			after: timers.after,
			roomShort: () =>
				new Promise<string | undefined>((resolve) => {
					answer = resolve;
				}),
		});
		await timers.fire();
		stop();
		answer(undefined);
		await new Promise((resolve) => setImmediate(resolve));
		expect(roll).not.toHaveBeenCalled();
		expect(timers.due).toEqual([]);
	});

	it("says nothing of looking again when a look throws after the child stopped", async () => {
		const timers = manualTimers();
		let fail = (_error: Error): void => undefined;
		const reported: unknown[] = [];
		const stop = rollWhenStale(
			() =>
				new Promise<string | undefined>((_resolve, reject) => {
					fail = reject;
				}),
			vi.fn(),
			{
				lookMs: 1,
				after: timers.after,
				report: (message) => reported.push(message),
			},
		);
		await timers.fire();
		stop();
		fail(new Error("unreadable install"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(reported).toEqual([]);
	});
});
