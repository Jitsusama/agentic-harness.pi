/**
 * The window a sender gives a hold: read from HH:MM or an ISO time, kept
 * only for a hold whose end falls after its start, and told back.
 */
import { describe, expect, it } from "vitest";
import {
	holdNote,
	timeWritten,
	windowAsked,
} from "../../../lib/mesh/hold-window.ts";
import { clock } from "../../../lib/mesh/message.ts";

const local = (hours: number, minutes: number, dayOffset = 0): number => {
	const day = new Date(2026, 10, 24, hours, minutes, 0, 0);
	day.setDate(day.getDate() + dayOffset);
	return day.getTime();
};
const now = local(12, 14);
const iso = (ms: number) => new Date(ms).toISOString();

describe("a time written for a window", () => {
	it("reads HH:MM as today's, or tomorrow's once today's has passed", () => {
		expect(timeWritten("13:10", now)).toBe(local(13, 10));
		expect(timeWritten(" 9:05 ", now)).toBe(local(9, 5, 1));
		expect(timeWritten("12:14", now), "now itself is past").toBe(
			local(12, 14, 1),
		);
	});

	it("reads an ISO time as it says", () => {
		expect(timeWritten(iso(local(15, 0)), now)).toBe(local(15, 0));
	});

	it("reads nothing from what is no time of day", () => {
		for (const written of ["24:00", "12:60", "noon", "2026-11-24", "1300"]) {
			expect(timeWritten(written, now), written).toBeUndefined();
		}
	});
});

describe("a window asked of a send", () => {
	it("keeps both ends of a hold, its end counted after its start", () => {
		expect(windowAsked("hold", "12:30", "13:10", now)).toEqual({
			window: { starts: iso(local(12, 30)), ends: iso(local(13, 10)) },
			notes: [],
		});
		expect(
			windowAsked("hold", "23:30", "00:30", now).window.ends,
			"an end past midnight is the next day's",
		).toBe(iso(local(0, 30, 1)));
	});

	it("holds from now when given only an end", () => {
		expect(windowAsked("hold", undefined, "13:10", now)).toEqual({
			window: { ends: iso(local(13, 10)) },
			notes: [],
		});
	});

	it("leaves out and says an end at or before the start", () => {
		const asked = windowAsked(
			"hold",
			iso(local(13, 0)),
			iso(local(12, 30)),
			now,
		);
		expect(asked.window).toEqual({ starts: iso(local(13, 0)) });
		expect(asked.notes).toEqual([
			expect.stringContaining("falls before the hold starts"),
		]);
	});

	it("leaves out and says a time it can't read", () => {
		const asked = windowAsked("hold", "soon", "later", now);
		expect(asked.window).toEqual({});
		expect(asked.notes).toHaveLength(2);
	});

	it("gives a message that isn't a hold no window, and says so", () => {
		const asked = windowAsked("fyi", undefined, "13:10", now);
		expect(asked.window).toEqual({});
		expect(asked.notes).toEqual([
			expect.stringContaining("only a hold has a window"),
		]);
		expect(windowAsked("fyi", undefined, undefined, now)).toEqual({
			window: {},
			notes: [],
		});
	});
});

describe("what a holder is told", () => {
	const hold = { id: "1-X-1-abcd1234", at: iso(now) };

	it("says when a windowed hold starts and ends by itself", () => {
		const starts = iso(local(12, 30));
		const ends = iso(local(13, 10));
		const note = holdNote({ ...hold, starts, ends });
		expect(note).toContain(`It holds nobody until ${clock({ at: starts })}.`);
		expect(note).toContain(`It ends by itself at ${clock({ at: ends })}`);
		expect(note).toContain("[abcd1234] with endsHold to end it sooner");
	});

	it("says the two-hour bound for one with no end", () => {
		expect(holdNote(hold)).toMatch(/^It holds for two hours at most/);
	});
});
