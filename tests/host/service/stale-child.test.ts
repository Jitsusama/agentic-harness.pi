/** A child host rolls its conversation onto new code once its install moves on. */
import { describe, expect, it, vi } from "vitest";
import {
	ROLL_ONLY_AFTER_MS,
	ROLL_SPREAD_MS,
	rollChildWhenStale,
	rollWhenStale,
} from "../../../host/service/stale-child.ts";

// The CPU's pressure as a child reads it by default, set by a case.
const cpu = vi.hoisted(() => ({ short: undefined as string | undefined }));
vi.mock("../../../lib/internal/machine/room.ts", () => ({
	cpuShort: async () => cpu.short,
}));

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
			"Moved, but the machine is busy (CPU some avg60 was 64.7, at or past 40), so it looks again each 7 minutes until it has room, rolling anyway after 60 minutes",
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
		expect(reported).toHaveLength(2);
		expect(reported[1]).toMatch(/^Moved again, but the machine is busy/);
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
		expect(timers.due, "it spreads once, not at each look").toEqual([]);
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
			"The host's code differs, but the machine is busy (CPU some avg60 was 64.7, at or past 40), so it looks again each 5 minutes until it has room, rolling anyway after 60 minutes",
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

describe("rollChildWhenStale", () => {
	/** A child's wiring, its host stopping when `stop` is called. */
	function wired(
		moved: () => Promise<string | undefined>,
		clock: {
			bornAt?: number;
			now?: () => number;
			roomShort?: () => Promise<string | undefined>;
		} = {},
	) {
		const timers = manualTimers();
		const reported: unknown[] = [];
		const rolled: string[] = [];
		let host: { roll(): void } | undefined;
		let end = (_how: "resolve" | "reject"): void => undefined;
		const stopped = new Promise<void>((resolve, reject) => {
			end = (how) => (how === "resolve" ? resolve() : reject(new Error("x")));
		});
		// The rejection is the child's host failing, which its program handles.
		stopped.catch(() => undefined);
		rollChildWhenStale({
			moved,
			host: () => host,
			stopped,
			report: (message) => reported.push(message),
			lookMs: 1,
			after: timers.after,
			// A child an hour old unless a case says otherwise.
			bornAt: clock.bornAt ?? 0,
			now: clock.now ?? (() => ROLL_ONLY_AFTER_MS),
			// No spread, and room, unless a case says otherwise.
			spreadMs: 0,
			roomShort: clock.roomShort ?? (async () => undefined),
		});
		return {
			timers,
			reported,
			rolled,
			holds: (name: string) => {
				host = { roll: () => rolled.push(name) };
			},
			end,
		};
	}

	it("rolls the host holding the conversation when the install moves, saying why", async () => {
		const child = wired(async () => "the host's code differs");
		child.holds("made after the wiring");
		await child.timers.fire();
		expect(child.rolled).toEqual(["made after the wiring"]);
		expect(child.reported).toEqual([
			"Rolling onto new code, as the host's code differs: the conversation parks at its next quiet moment unless a window views it",
		]);
	});

	it("rolls a child no sooner than an hour after it started, so a conversation rolls at most once an hour", async () => {
		let now = 10_000;
		const child = wired(async () => "the host's code differs", {
			bornAt: 10_000,
			now: () => now,
		});
		child.holds("young");
		now += 6 * 60_000;
		await child.timers.fire();
		expect(child.rolled, "six minutes old").toEqual([]);
		expect(child.timers.due.map(({ ms }) => ms)).toEqual([
			ROLL_ONLY_AFTER_MS - 6 * 60_000,
		]);

		now = 10_000 + ROLL_ONLY_AFTER_MS;
		await child.timers.fire();
		expect(child.rolled).toEqual(["young"]);
	});

	it("takes its start as the wiring's moment when it isn't told one", async () => {
		const timers = manualTimers();
		const rolled: string[] = [];
		// Long past an hour since the epoch, so a start taken as 0 would roll.
		const wiredAt = 10 * ROLL_ONLY_AFTER_MS;
		let now = wiredAt;
		rollChildWhenStale({
			moved: async () => "moved",
			host: () => ({ roll: () => rolled.push("rolled") }),
			stopped: new Promise(() => undefined),
			report: () => undefined,
			lookMs: 1,
			after: timers.after,
			now: () => now,
			spreadMs: 0,
			roomShort: async () => undefined,
		});
		now += 1;
		await timers.fire();
		expect(rolled, "just started").toEqual([]);
		now = wiredAt + ROLL_ONLY_AFTER_MS;
		await timers.fire();
		expect(rolled).toEqual(["rolled"]);
	});

	it("holds its roll while the machine it is told of is busy", async () => {
		let short: string | undefined = "CPU some avg60 was 61.7, at or past 40";
		const child = wired(async () => "the host's code differs", {
			roomShort: async () => short,
		});
		child.holds("busy");
		await child.timers.fire();
		expect(child.rolled).toEqual([]);
		short = undefined;
		await child.timers.fire();
		expect(child.rolled).toEqual(["busy"]);
	});

	it("holds its roll on the CPU's pressure when it isn't told how to read the machine", async () => {
		const timers = manualTimers();
		const rolled: string[] = [];
		cpu.short = "CPU some avg60 was 64.7, at or past 40";
		try {
			rollChildWhenStale({
				moved: async () => "moved",
				host: () => ({ roll: () => rolled.push("rolled") }),
				stopped: new Promise(() => undefined),
				report: () => undefined,
				lookMs: 1,
				after: timers.after,
				bornAt: 0,
				now: () => ROLL_ONLY_AFTER_MS,
				spreadMs: 0,
			});
			await timers.fire();
			expect(rolled, "busy").toEqual([]);
			cpu.short = undefined;
			await timers.fire();
			expect(rolled).toEqual(["rolled"]);
		} finally {
			cpu.short = undefined;
		}
	});

	it("draws its spread at random across ten minutes when it isn't told one", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const timers = manualTimers();
			rollChildWhenStale({
				moved: async () => "moved",
				host: () => undefined,
				stopped: new Promise(() => undefined),
				report: () => undefined,
				lookMs: 1,
				after: timers.after,
				bornAt: 0,
				now: () => ROLL_ONLY_AFTER_MS,
				roomShort: async () => undefined,
			});
			await timers.fire();
			expect(ROLL_SPREAD_MS, "ten minutes").toBe(10 * 60_000);
			expect(timers.due.map(({ ms }) => ms)).toEqual([ROLL_SPREAD_MS / 2]);
		} finally {
			random.mockRestore();
		}
	});

	for (const how of ["resolve", "reject"] as const)
		it(`stops looking once the child's host stops, as it does when it ${how}s`, async () => {
			const child = wired(async () => undefined);
			expect(child.timers.due).toHaveLength(1);
			child.end(how);
			await new Promise((resolve) => setImmediate(resolve));
			expect(child.timers.due).toEqual([]);
		});
});
