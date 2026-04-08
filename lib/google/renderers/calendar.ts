/**
 * Calendar event and free/busy rendering to markdown.
 */

import type { BusyPeriod, CalendarEvent, FreeBusyResult } from "../types.js";

/**
 * Render calendar events as markdown.
 */
export function renderEventList(events: CalendarEvent[]): string {
	if (events.length === 0) {
		return "No events found.";
	}

	const lines: string[] = ["# Calendar Events\n"];

	// We group the events by date.
	let currentDate = "";
	for (const event of events) {
		const eventDate = extractDate(event.start);

		if (eventDate !== currentDate) {
			currentDate = eventDate;
			lines.push(`## ${formatDateHeader(event.start)}\n`);
		}

		const timeRange = formatTimeRange(event.start, event.end);
		const location = event.location ? ` · 📍 ${event.location}` : "";
		const status = getEventStatus(event);

		lines.push(`- **${event.summary}**${status}`);
		lines.push(`  ${timeRange}${location}`);

		if (event.attendees && event.attendees.length > 0) {
			const attendeeNames = event.attendees
				.slice(0, 3)
				.map((a) => a.displayName || a.email)
				.join(", ");
			const moreCount = event.attendees.length - 3;
			const more = moreCount > 0 ? ` +${moreCount} more` : "";
			lines.push(`  👥 ${attendeeNames}${more}`);
		}

		lines.push(`  \`${event.id}\``);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Render a single calendar event as markdown.
 */
export function renderEvent(event: CalendarEvent): string {
	const lines: string[] = [];

	lines.push(`# ${event.summary}\n`);

	const timeRange = formatTimeRange(event.start, event.end);
	lines.push(`- **When:** ${timeRange}`);

	if (event.location) {
		lines.push(`- **Where:** ${event.location}`);
	}

	if (event.attendees && event.attendees.length > 0) {
		const attendeeList = event.attendees
			.map((a) => {
				const name = a.displayName || a.email;
				const status = formatAttendeeStatus(a.responseStatus);
				const self = a.self ? " (you)" : "";
				return `${name}${status}${self}`;
			})
			.join(", ");
		lines.push(`- **Attendees:** ${attendeeList}`);
	}

	const myStatus = getMyResponseStatus(event);
	if (myStatus) {
		lines.push(`- **Your status:** ${myStatus}`);
	}

	lines.push(`- **ID:** \`${event.id}\``);

	if (event.description) {
		lines.push("\n---\n");
		lines.push(event.description);
	}

	// Conference link
	const meetLink = getMeetLink(event);
	if (meetLink) {
		lines.push(`\n**Join:** [Google Meet](${meetLink})`);
	}

	return lines.join("\n");
}

function extractDate(isoDateTime: string): string {
	return isoDateTime.split("T")[0] || "";
}

function formatDateHeader(isoDateTime: string): string {
	try {
		const date = new Date(isoDateTime);
		return date.toLocaleDateString("en-US", {
			weekday: "long",
			month: "long",
			day: "numeric",
		});
	} catch (_error) {
		// Date parsing failed, so we return the date portion of the ISO string as a fallback.
		return isoDateTime.split("T")[0] || "";
	}
}

function formatTimeRange(start: string, end: string): string {
	try {
		const startDate = new Date(start);
		const endDate = new Date(end);

		// All-day event
		if (start.length === 10) {
			return `All day (${start})`;
		}

		// Same day
		if (startDate.toLocaleDateString() === endDate.toLocaleDateString()) {
			const startTime = startDate.toLocaleTimeString("en-US", {
				hour: "numeric",
				minute: "2-digit",
			});
			const endTime = endDate.toLocaleTimeString("en-US", {
				hour: "numeric",
				minute: "2-digit",
			});
			const date = startDate.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
			});
			return `${date} ${startTime}–${endTime}`;
		}

		// Multi-day
		const startStr = startDate.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
		const endStr = endDate.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
		return `${startStr} → ${endStr}`;
	} catch (_error) {
		// Date parsing failed, so we return the raw ISO strings as a fallback.
		return `${start} – ${end}`;
	}
}

function formatAttendeeStatus(
	status?: "accepted" | "declined" | "tentative" | "needsAction",
): string {
	switch (status) {
		case "accepted":
			return " ✓";
		case "declined":
			return " ✗";
		case "tentative":
			return " ❓";
		case "needsAction":
			return " ⏳";
		default:
			return "";
	}
}

function getEventStatus(event: CalendarEvent): string {
	const myAttendee = event.attendees?.find((a) => a.self);
	if (!myAttendee) return "";

	switch (myAttendee.responseStatus) {
		case "accepted":
			return " ✓";
		case "declined":
			return " ~~declined~~";
		case "tentative":
			return " ❓";
		case "needsAction":
			return " ⏳";
		default:
			return "";
	}
}

function getMyResponseStatus(event: CalendarEvent): string | null {
	const myAttendee = event.attendees?.find((a) => a.self);
	if (!myAttendee) return null;

	switch (myAttendee.responseStatus) {
		case "accepted":
			return "Accepted ✓";
		case "declined":
			return "Declined";
		case "tentative":
			return "Tentative ❓";
		case "needsAction":
			return "Not responded ⏳";
		default:
			return null;
	}
}

function getMeetLink(event: CalendarEvent): string | null {
	const meetEntry = event.conferenceData?.entryPoints?.find(
		(ep) =>
			ep.entryPointType === "video" && ep.uri?.includes("meet.google.com"),
	);
	return meetEntry?.uri || null;
}

/**
 * Render free/busy results as markdown, showing each
 * person's busy blocks and the common free slots where
 * everyone is available.
 */
export function renderFreeBusy(result: FreeBusyResult): string {
	const lines: string[] = ["# Availability Check\n"];

	const windowStart = formatTimeShort(result.timeMin);
	const windowEnd = formatTimeShort(result.timeMax);
	lines.push(`**Window:** ${windowStart} \u2013 ${windowEnd}\n`);

	// We render each person's busy blocks.
	for (const cal of result.calendars) {
		const label = cal.self ? "You" : cal.email;
		lines.push(`## ${label}\n`);

		if (cal.errors && cal.errors.length > 0) {
			lines.push(`\u26a0\ufe0f ${cal.errors.join(", ")}\n`);
			continue;
		}

		if (cal.busy.length === 0) {
			lines.push("No busy blocks \u2014 fully available.\n");
			continue;
		}

		for (const period of cal.busy) {
			const start = formatTimeShort(period.start);
			const end = formatTimeShort(period.end);
			lines.push(`- \ud83d\udd34 Busy: ${start} \u2013 ${end}`);
		}
		lines.push("");
	}

	// We compute and render common free slots.
	const allBusy = result.calendars
		.filter((c) => !c.errors || c.errors.length === 0)
		.flatMap((c) => c.busy);

	const freeSlots = computeFreeSlots(allBusy, result.timeMin, result.timeMax);

	lines.push("## Common Free Slots\n");

	if (freeSlots.length === 0) {
		lines.push("No common free time in this window.");
	} else {
		for (const slot of freeSlots) {
			const start = formatTimeShort(slot.start);
			const end = formatTimeShort(slot.end);
			const duration = formatDuration(slot.start, slot.end);
			lines.push(`- \u2705 ${start} \u2013 ${end} (${duration})`);
		}
	}

	return lines.join("\n");
}

/**
 * Compute free slots by merging all busy periods and finding
 * the gaps within the query window.
 */
function computeFreeSlots(
	busy: BusyPeriod[],
	windowStart: string,
	windowEnd: string,
): BusyPeriod[] {
	if (busy.length === 0) {
		return [{ start: windowStart, end: windowEnd }];
	}

	// We sort by start time, then merge overlapping ranges.
	const sorted = [...busy].sort(
		(a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
	);

	const merged: BusyPeriod[] = [];
	let current = { ...sorted[0] };

	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i];
		if (new Date(next.start).getTime() <= new Date(current.end).getTime()) {
			// Overlapping or adjacent; we extend the current range.
			if (new Date(next.end).getTime() > new Date(current.end).getTime()) {
				current.end = next.end;
			}
		} else {
			merged.push(current);
			current = { ...next };
		}
	}
	merged.push(current);

	// We walk the merged busy blocks and collect the gaps.
	const freeSlots: BusyPeriod[] = [];
	let cursor = new Date(windowStart).getTime();
	const end = new Date(windowEnd).getTime();

	for (const block of merged) {
		const blockStart = new Date(block.start).getTime();
		const blockEnd = new Date(block.end).getTime();

		if (blockStart > cursor) {
			freeSlots.push({
				start: new Date(cursor).toISOString(),
				end: new Date(Math.min(blockStart, end)).toISOString(),
			});
		}
		cursor = Math.max(cursor, blockEnd);
	}

	if (cursor < end) {
		freeSlots.push({
			start: new Date(cursor).toISOString(),
			end: new Date(end).toISOString(),
		});
	}

	return freeSlots;
}

/** Format an ISO datetime as a short, human-readable string. */
function formatTimeShort(iso: string): string {
	try {
		const date = new Date(iso);
		return date.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		// Date parsing failed, so we return the raw string.
		return iso;
	}
}

/** Format the duration between two ISO datetimes. */
function formatDuration(start: string, end: string): string {
	const ms = new Date(end).getTime() - new Date(start).getTime();
	const minutes = Math.round(ms / 60_000);

	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const remaining = minutes % 60;
	return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}
