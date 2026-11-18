/**
 * How long a host's stop parks, read from the stop limit its unit names,
 * and how long a stop that ran out took, as its journal line says.
 */

import { describe, expect, it } from "vitest";
import {
	endWithin,
	stopWithin,
	unparkedLine,
} from "../../../host/service/stop.ts";

/** The longest a Node timer waits: past it, setTimeout fires at once. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

// At 03:30 on 17 November a restart's park of 13 conversations was still
// under way when its 45 s ran out late on a busy loop, and systemd's 60 s
// stop killed it. The unit's stop limit is the one to fit inside, so the
// unit says it and the host parks within three quarters of it.
describe("stopWithin", () => {
	it("parks within three quarters of the stop limit its unit names", () => {
		expect(stopWithin({ PI_HOST_STOP_USEC: "150000000" })).toBe(112_500);
		expect(stopWithin({ PI_HOST_STOP_USEC: "100000000" })).toBe(75_000);
	});

	it("parks for whole milliseconds, which its journal line names", () => {
		expect(stopWithin({ PI_HOST_STOP_USEC: "150001000" })).toBe(112_500);
	});

	it("parks no longer than a timer can wait, so systemd's infinity never ends a stop at once", () => {
		expect(
			stopWithin({ PI_HOST_STOP_USEC: "18446744073709551615" }),
			"USEC_INFINITY, as systemd writes it",
		).toBe(LONGEST_TIMER_MS);
	});

	it("parks within 45 s when its unit names no stop limit it can read", () => {
		for (const env of [
			{},
			{ PI_HOST_STOP_USEC: "" },
			{ PI_HOST_STOP_USEC: "0" },
			{ PI_HOST_STOP_USEC: "soon" },
			{ PI_HOST_STOP_USEC: "-5" },
		])
			expect(stopWithin(env), JSON.stringify(env)).toBe(45_000);
	});
});

// A busy loop comes to its bound late, which is what 17 November's stop
// did; the line says how long the stop really took beside its bound.
describe("endWithin", () => {
	it("tells how long the stop took once its bound ran out", async () => {
		const told: number[] = [];
		await endWithin(new Promise<void>(() => {}), 20, (waited) =>
			told.push(waited),
		);
		expect(told, "told once").toHaveLength(1);
		expect(told[0], "no sooner than its bound").toBeGreaterThanOrEqual(19);
	});
});

describe("unparkedLine", () => {
	it("names how long the stop took, its bound and each conversation left", () => {
		expect(unparkedLine(300, 342, [{ id: "a" }, { id: "b" }])).toBe(
			"stopping after 342 ms, past its 300 ms bound, 2 not parked: a, b",
		);
	});
});
