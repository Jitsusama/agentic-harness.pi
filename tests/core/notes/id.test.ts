import { describe, expect, it } from "vitest";
import {
	dateOf,
	isId,
	mintId,
	mintIdFromDateString,
} from "../../../lib/core/internal/notes/id.ts";

describe("mintId", () => {
	it("produces an id of the form NOTE-YYYYMMDD-XXXXXX", () => {
		const id = mintId(new Date("2026-06-03T12:00:00"));
		expect(id).toMatch(/^NOTE-2026060[23]-[0-9A-Z]{6}$/);
	});

	it("uses the given date for the YYYYMMDD portion", () => {
		const id = mintId(new Date(2026, 5, 3, 12)); // local zone
		expect(dateOf(id)).toBe("20260603");
	});

	it("produces 1000 distinct ids in a tight loop", () => {
		const ids = new Set<string>();
		const now = new Date();
		for (let i = 0; i < 1000; i++) ids.add(mintId(now));
		// Collisions on a 36^6 (~2.18B) space are astronomically
		// unlikely; if we see any here something is broken in the
		// randomness path.
		expect(ids.size).toBe(1000);
	});
});

describe("mintIdFromDateString", () => {
	it("uses the leading YYYYMMDD of a full timestamp", () => {
		const id = mintIdFromDateString("20130120T145200Z");
		expect(dateOf(id)).toBe("20130120");
	});

	it("accepts a bare YYYYMMDD", () => {
		const id = mintIdFromDateString("20130120");
		expect(dateOf(id)).toBe("20130120");
	});

	it("falls back to today when the string doesn't start with 8 digits", () => {
		const id = mintIdFromDateString("garbage");
		expect(dateOf(id)).toBe(dateOf(mintId()));
	});

	it("falls back to today when undefined", () => {
		const id = mintIdFromDateString(undefined);
		expect(dateOf(id)).toBe(dateOf(mintId()));
	});
});

describe("isId / dateOf", () => {
	it("accepts a valid id", () => {
		expect(isId("NOTE-20260603-AB12CD"), "a well-formed id is accepted").toBe(
			true,
		);
	});

	it("rejects invalid ids", () => {
		expect(
			isId("NOTE-20260603-ab12cd"),
			"an id with a lowercase suffix is refused",
		).toBe(false);
		expect(
			isId("NOTE-20260603-AB12"),
			"an id with a short suffix is refused",
		).toBe(false);
		expect(
			isId("QEST-20260603-AB12CD"),
			"an id with a quest's prefix is refused",
		).toBe(false);
		expect(
			isId("NOTE-2026063-AB12CD"),
			"an id with a seven-digit date is refused",
		).toBe(false);
		expect(isId("not-an-id"), "a string of no id shape is refused").toBe(false);
	});

	it("rejects impossible calendar dates that pass digit-count", () => {
		expect(
			isId("NOTE-00000000-AAAAAA"),
			"an id dated in year 0000 is refused",
		).toBe(false);
		expect(
			isId("NOTE-20261345-AAAAAA"),
			"an id dated month 13, day 45 is refused",
		).toBe(false);
		expect(
			isId("NOTE-20260230-AAAAAA"),
			"an id dated February 30 is accepted, since the check is of shape, not calendar",
		).toBe(true);
		expect(
			isId("NOTE-20260001-AAAAAA"),
			"an id dated month 00 is refused",
		).toBe(false);
		expect(isId("NOTE-20260100-AAAAAA"), "an id dated day 00 is refused").toBe(
			false,
		);
	});

	it("dateOf returns undefined for an invalid id", () => {
		expect(dateOf("not-an-id")).toBeUndefined();
	});
});
