import { describe, expect, it } from "vitest";
import {
	computeFreeSlots,
	renderEventList,
} from "../../../../lib/google/renderers/calendar.js";
import type { CalendarEvent } from "../../../../lib/google/types.js";

const WINDOW_START = "2026-01-05T09:00:00.000Z";
const WINDOW_END = "2026-01-05T17:00:00.000Z";

describe("computeFreeSlots", () => {
	it("returns the whole window when nobody is busy", () => {
		const slots = computeFreeSlots([], WINDOW_START, WINDOW_END);
		expect(slots).toEqual([{ start: WINDOW_START, end: WINDOW_END }]);
	});

	it("merges unsorted overlapping busy blocks into one gap", () => {
		// Given out of order and overlapping, they collapse to one busy
		// span 10:00-12:00, leaving free time on either side.
		const slots = computeFreeSlots(
			[
				{ start: "2026-01-05T11:00:00.000Z", end: "2026-01-05T12:00:00.000Z" },
				{ start: "2026-01-05T10:00:00.000Z", end: "2026-01-05T11:30:00.000Z" },
			],
			WINDOW_START,
			WINDOW_END,
		);

		expect(slots).toEqual([
			{ start: WINDOW_START, end: "2026-01-05T10:00:00.000Z" },
			{ start: "2026-01-05T12:00:00.000Z", end: WINDOW_END },
		]);
	});

	it("merges blocks that only touch at their boundary", () => {
		const slots = computeFreeSlots(
			[
				{ start: "2026-01-05T10:00:00.000Z", end: "2026-01-05T11:00:00.000Z" },
				{ start: "2026-01-05T11:00:00.000Z", end: "2026-01-05T12:00:00.000Z" },
			],
			WINDOW_START,
			WINDOW_END,
		);

		expect(slots).toEqual([
			{ start: WINDOW_START, end: "2026-01-05T10:00:00.000Z" },
			{ start: "2026-01-05T12:00:00.000Z", end: WINDOW_END },
		]);
	});

	it("yields no leading free slot for a block straddling the window start", () => {
		const slots = computeFreeSlots(
			[{ start: "2026-01-05T08:00:00.000Z", end: "2026-01-05T10:00:00.000Z" }],
			WINDOW_START,
			WINDOW_END,
		);

		expect(slots).toEqual([
			{ start: "2026-01-05T10:00:00.000Z", end: WINDOW_END },
		]);
	});
});

describe("renderEventList", () => {
	it("reports the empty state when there are no events", () => {
		expect(renderEventList([])).toBe("No events found.");
	});

	it("groups same-day events under one date header with location and attendee overflow", () => {
		const events: CalendarEvent[] = [
			{
				id: "evt-1",
				summary: "Standup",
				start: "2026-01-05T09:00:00.000Z",
				end: "2026-01-05T09:15:00.000Z",
				location: "Room 4",
				attendees: [
					{ email: "a@x.com" },
					{ email: "b@x.com" },
					{ email: "c@x.com" },
					{ email: "d@x.com" },
				],
			},
			{
				id: "evt-2",
				summary: "Review",
				start: "2026-01-05T14:00:00.000Z",
				end: "2026-01-05T15:00:00.000Z",
			},
		];

		const md = renderEventList(events);

		// Two events on the same date share a single "## " header.
		expect(md.match(/\n## /g)).toHaveLength(1);
		expect(md).toContain("📍 Room 4");
		expect(md).toContain("+1 more");
		expect(md).toContain("Standup");
		expect(md).toContain("Review");
	});
});
