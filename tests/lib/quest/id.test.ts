import { describe, expect, it } from "vitest";
import {
	dateOf,
	findIds,
	isId,
	mintId,
	prefixOf,
} from "../../../lib/internal/quest/id";

describe("mintId", () => {
	it("produces an id of the form PREFIX-YYYYMMDD-XXXXXX", () => {
		const id = mintId("QEST", new Date("2026-06-03T12:00:00"));
		expect(id).toMatch(/^QEST-2026060[23]-[0-9A-Z]{6}$/);
	});

	it("uses the given date for the YYYYMMDD portion", () => {
		const id = mintId("PLAN", new Date(2026, 5, 3, 12)); // local zone
		expect(dateOf(id)).toBe("20260603");
	});

	it("produces 1000 distinct ids in a tight loop", () => {
		const ids = new Set<string>();
		const now = new Date();
		for (let i = 0; i < 1000; i++) ids.add(mintId("QEST", now));
		// Collisions on a 36^6 (~2.18B) space are
		// astronomically unlikely; if we see any here
		// something is broken in the randomness path.
		expect(ids.size).toBe(1000);
	});

	it("supports every recognised prefix", () => {
		for (const prefix of ["QEST", "PLAN", "RSCH", "BRIF", "RPRT"] as const) {
			expect(prefixOf(mintId(prefix))).toBe(prefix);
		}
	});
});

describe("isId / prefixOf / dateOf", () => {
	it("accepts valid ids", () => {
		expect(isId("QEST-20260603-AB12CD")).toBe(true);
		expect(isId("PLAN-20260603-AB12CD")).toBe(true);
	});

	it("rejects invalid ids", () => {
		expect(isId("QEST-20260603-ab12cd")).toBe(false); // lowercase
		expect(isId("QEST-20260603-AB12")).toBe(false); // too short
		expect(isId("XXXX-20260603-AB12CD")).toBe(false); // unknown prefix
		expect(isId("QEST-2026063-AB12CD")).toBe(false); // bad date
		expect(isId("not-an-id")).toBe(false);
	});

	it("prefixOf returns undefined for invalid", () => {
		expect(prefixOf("not-an-id")).toBeUndefined();
	});

	it("dateOf returns undefined for invalid", () => {
		expect(dateOf("not-an-id")).toBeUndefined();
	});
});

describe("findIds", () => {
	it("finds every distinct id in a body", () => {
		const text = [
			"See QEST-20260603-AAA111 and PLAN-20260604-BBB222.",
			"Also QEST-20260603-AAA111 again (duplicate).",
			"Unrelated: not-an-id.",
		].join("\n");
		expect(findIds(text)).toEqual([
			"QEST-20260603-AAA111",
			"PLAN-20260604-BBB222",
		]);
	});

	it("returns an empty array when no ids are present", () => {
		expect(findIds("plain prose")).toEqual([]);
	});
});
