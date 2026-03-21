/**
 * Calendar event rendering to markdown.
 */

import type { CalendarEvent } from "../types.js";

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
