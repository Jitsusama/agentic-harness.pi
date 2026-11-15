/**
 * A real week cut into the soak's days takes every prompt once, weighs
 * the days alike, and keeps each day's busiest sessions whole rather
 * than packing its conversations level.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONVERSATIONS, DAYS, daysOf } from "./week.ts";

const sum = (values: readonly number[]) =>
	values.reduce((total, value) => total + value, 0);

describe("a week's days", () => {
	it("take every prompt once, in the days and conversations asked for", () => {
		const days = daysOf([9, 7, 5, 4, 3, 2, 1, 1], 2, 3);
		expect(days, "two days of three conversations").toEqual([
			[9, 4, 4],
			[7, 5, 3],
		]);
	});

	it("keep each conversation's busiest session whole, the busiest first", () => {
		const [day] = daysOf([100, 10, 1, 1], 1, 2);
		expect(day, "the busy session and the quiet ones after the other").toEqual([
			101, 11,
		]);
	});

	it("leave out a conversation with no session", () => {
		expect(daysOf([5], 1, 3), "one session, one conversation").toEqual([[5]]);
	});

	it("cut the real week into seven days of twenty, each near a seventh of it", () => {
		const week: unknown = JSON.parse(
			readFileSync(resolve(import.meta.dirname, "week.json"), "utf8"),
		);
		const sessions = Array.isArray(week)
			? week.filter((one): one is number => typeof one === "number")
			: [];
		const days = daysOf(sessions);
		expect(days.length, "seven days").toBe(DAYS);
		expect(
			days.map((day) => day.length),
			"twenty conversations a day",
		).toEqual(Array.from({ length: DAYS }, () => CONVERSATIONS));
		expect(sum(days.map(sum)), "the week's every prompt").toBe(sum(sessions));
		for (const day of days)
			expect(
				Math.abs(sum(day) - sum(sessions) / DAYS),
				"a day within a sixth of a seventh",
			).toBeLessThan(sum(sessions) / DAYS / 6);
		expect(days[0]?.[0], "the week's busiest session, whole").toBeGreaterThan(
			Math.max(...sessions),
		);
	});
});
