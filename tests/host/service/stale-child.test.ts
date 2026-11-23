/** A child host rolls its conversation onto new code once its install moves on. */
import { describe, expect, it, vi } from "vitest";
import {
	rollChildWhenStale,
	rollWhenStale,
} from "../../../host/service/stale-child.ts";

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
		stop();
		expect(timers.due).toEqual([]);
		expect(roll).not.toHaveBeenCalled();
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
	function wired(moved: () => Promise<string | undefined>) {
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

	for (const how of ["resolve", "reject"] as const)
		it(`stops looking once the child's host stops, as it does when it ${how}s`, async () => {
			const child = wired(async () => undefined);
			expect(child.timers.due).toHaveLength(1);
			child.end(how);
			await new Promise((resolve) => setImmediate(resolve));
			expect(child.timers.due).toEqual([]);
		});
});
