/** The carries under way that every door ending a session asks. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CARRY_HOLDS_MOST_MS,
	type CarryHold,
	carryUnderWay,
	type HoldTiming,
	holdForCarry,
} from "../../../../lib/internal/carry/under-way.ts";

const session = "01a1ecbb-0000-7000-8000-00000000c4ee";
const other = "01a15f3a-0000-7463-9909-afa624b025fe";

describe("a carry under way", () => {
	const held: CarryHold[] = [];
	afterEach(() => {
		for (const hold of held.splice(0)) hold.release();
		vi.useRealTimers();
	});

	/** A hold let go after the test, whether it passed or not. */
	const hold = (to: string, timing: HoldTiming = {}, of = session) => {
		const one = holdForCarry(of, to, timing);
		held.push(one);
		return one;
	};

	it("holds its session until it lets go", () => {
		const carry = hold("penelope");

		const during = carryUnderWay(session);
		carry.release();

		expect(during).toBe("penelope");
		expect(carryUnderWay(session)).toBeUndefined();
	});

	it("holds only its own session", () => {
		hold("penelope");

		expect(carryUnderWay(other)).toBeUndefined();
	});

	it("keeps another carry's hold when the first lets go", () => {
		const first = hold("penelope");
		hold("equilibrius");

		first.release();
		first.release();

		expect(carryUnderWay(session)).toBe("equilibrius");
	});

	it("sets aside the hold of the carry asking", () => {
		const own = hold("penelope");

		expect(carryUnderWay(session, { except: own })).toBeUndefined();
	});

	it("answers the newest carry's machine when several hold", () => {
		let now = 0;
		hold("penelope", { now: () => now });
		now = 1;
		hold("equilibrius", { now: () => now });

		expect(carryUnderWay(session, { now })).toBe("equilibrius");
	});

	it("lets go once it has held its whole time, on its own clock", () => {
		let now = 1_000;
		hold("penelope", { now: () => now });

		now += CARRY_HOLDS_MOST_MS - 1;
		const early = carryUnderWay(session, { now });
		now += 1;
		const late = carryUnderWay(session, { now });

		expect(early).toBe("penelope");
		expect(late).toBeUndefined();
	});

	// Two carries of one session would write one handover, so only the
	// doors lapse (PV3TE0's F13).
	it("still turns a second carry away once its hold has lapsed, until it lets go", () => {
		let now = 1_000;
		const carry = hold("penelope", { now: () => now });

		now += CARRY_HOLDS_MOST_MS;
		const lapsed = carryUnderWay(session, { now, evenLapsed: true });
		carry.release();

		expect(lapsed).toBe("penelope");
		expect(carryUnderWay(session, { now, evenLapsed: true })).toBeUndefined();
	});

	it("lets a lapse that throws go by, so its bare timer never ends the process", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		hold("penelope", {
			mostMs: 0,
			lapsed: () => {
				throw new Error("the context is stale");
			},
		});

		expect(() => vi.advanceTimersByTime(1)).not.toThrow();
	});

	it("says once that a carry outlived its hold", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const told: string[] = [];
		const carry = hold("penelope", {
			lapsed: (one) => told.push(one.to),
		});

		vi.advanceTimersByTime(CARRY_HOLDS_MOST_MS - 1);
		const early = [...told];
		vi.advanceTimersByTime(CARRY_HOLDS_MOST_MS);
		carry.release();

		expect(early).toEqual([]);
		expect(told).toEqual(["penelope"]);
	});

	it("says nothing of a carry that let go in time", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const told: string[] = [];
		const carry = hold("penelope", {
			lapsed: (one) => told.push(one.to),
		});

		carry.release();
		vi.advanceTimersByTime(CARRY_HOLDS_MOST_MS);

		expect(told).toEqual([]);
	});
});
