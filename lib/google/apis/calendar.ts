/**
 * Google Calendar API client.
 */

import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type {
	BusyPeriod,
	CalendarEvent,
	CalendarFreeBusy,
	FreeBusyResult,
} from "../types.js";

/**
 * List calendar events in a date range.
 */
export async function listEvents(
	auth: OAuth2Client,
	options: {
		start?: string; // ISO date or "today"/"tomorrow"
		end?: string; // ISO date
		calendarId?: string;
		maxResults?: number;
	} = {},
): Promise<CalendarEvent[]> {
	const calendar = google.calendar({ version: "v3", auth });

	// We parse the date strings.
	const timeMin = parseDate(options.start || "today");
	const timeMax = parseDate(options.end);

	const response = await calendar.events.list({
		calendarId: options.calendarId || "primary",
		timeMin: timeMin.toISOString(),
		timeMax: timeMax?.toISOString(),
		maxResults: options.maxResults || 100,
		singleEvents: true,
		orderBy: "startTime",
	});

	const events: CalendarEvent[] = [];
	for (const event of response.data.items || []) {
		events.push(convertEvent(event));
	}

	return events;
}

/**
 * Get a single calendar event.
 */
export async function getEvent(
	auth: OAuth2Client,
	eventId: string,
	calendarId = "primary",
): Promise<CalendarEvent> {
	const calendar = google.calendar({ version: "v3", auth });

	const response = await calendar.events.get({
		calendarId,
		eventId,
	});

	return convertEvent(response.data);
}

function parseDate(dateStr?: string): Date {
	if (!dateStr) {
		// We default to the end of today.
		const date = new Date();
		date.setHours(23, 59, 59, 999);
		return date;
	}

	if (dateStr === "today") {
		const date = new Date();
		date.setHours(0, 0, 0, 0);
		return date;
	}

	if (dateStr === "tomorrow") {
		const date = new Date();
		date.setDate(date.getDate() + 1);
		date.setHours(0, 0, 0, 0);
		return date;
	}

	// We try to parse it as an ISO date.
	try {
		return new Date(dateStr);
	} catch (_error) {
		// The Date constructor threw, so we re-throw with context.
		throw new Error(`Invalid date: ${dateStr}`);
	}
}

function convertEvent(event: unknown): CalendarEvent {
	const e = event as {
		id?: string;
		summary?: string;
		description?: string;
		location?: string;
		start?: { dateTime?: string; date?: string };
		end?: { dateTime?: string; date?: string };
		attendees?: unknown[];
		conferenceData?: unknown;
		status?: string;
		htmlLink?: string;
	};

	const startTime = e.start?.dateTime || e.start?.date || "";
	const endTime = e.end?.dateTime || e.end?.date || "";

	return {
		id: e.id || "",
		summary: e.summary || "(no title)",
		description: e.description,
		location: e.location,
		start: startTime,
		end: endTime,
		attendees: convertAttendees(e.attendees),
		conferenceData: convertConferenceData(e.conferenceData),
		status: e.status,
		htmlLink: e.htmlLink,
	};
}

function convertAttendees(attendees: unknown): Array<{
	email: string;
	displayName?: string;
	responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
	self?: boolean;
}> {
	if (!Array.isArray(attendees)) return [];

	return attendees.map((a) => {
		const attendee = a as {
			email?: string;
			displayName?: string;
			responseStatus?: string;
			self?: boolean;
		};

		return {
			email: attendee.email || "",
			displayName: attendee.displayName,
			responseStatus: attendee.responseStatus as
				| "accepted"
				| "declined"
				| "tentative"
				| "needsAction",
			self: attendee.self,
		};
	});
}

function convertConferenceData(data: unknown): CalendarEvent["conferenceData"] {
	if (!data || typeof data !== "object") return undefined;

	const conf = data as { entryPoints?: unknown[] };
	if (!conf.entryPoints) return undefined;

	return {
		entryPoints: conf.entryPoints.map((ep) => {
			const entry = ep as {
				entryPointType?: string;
				uri?: string;
				label?: string;
			};

			return {
				entryPointType: entry.entryPointType || "",
				uri: entry.uri || "",
				label: entry.label,
			};
		}),
	};
}

/**
 * Create a calendar event.
 */
export async function createEvent(
	auth: OAuth2Client,
	options: {
		summary: string;
		start: string; // ISO datetime
		end: string;
		description?: string;
		location?: string;
		attendees?: string[];
		calendarId?: string;
	},
): Promise<CalendarEvent> {
	const calendar = google.calendar({ version: "v3", auth });

	const event = {
		summary: options.summary,
		description: options.description,
		location: options.location,
		start: {
			dateTime: options.start,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		},
		end: {
			dateTime: options.end,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		},
		attendees: options.attendees?.map((email) => ({ email })),
	};

	try {
		const response = await calendar.events.insert({
			calendarId: options.calendarId || "primary",
			requestBody: event,
			sendUpdates: "all", // Send invites to attendees
		});

		return convertEvent(response.data);
	} catch (error: unknown) {
		// We enhance the error message with details.
		if (error && typeof error === "object" && "message" in error) {
			const apiError = error as { message?: string; errors?: unknown[] };
			const details = apiError.errors
				? JSON.stringify(apiError.errors, null, 2)
				: "";
			throw new Error(
				`Calendar API error: ${apiError.message}\n${details}\n\n` +
					`Event data: ${JSON.stringify(event, null, 2)}`,
			);
		}
		throw error;
	}
}

/**
 * Update a calendar event.
 */
export async function updateEvent(
	auth: OAuth2Client,
	eventId: string,
	options: {
		summary?: string;
		start?: string;
		end?: string;
		description?: string;
		location?: string;
		attendees?: string[];
		calendarId?: string;
	},
): Promise<CalendarEvent> {
	const calendar = google.calendar({ version: "v3", auth });

	// We get the existing event first.
	const existing = await calendar.events.get({
		calendarId: options.calendarId || "primary",
		eventId,
	});

	// We merge the updates with the existing data.
	const event = {
		...existing.data,
		summary: options.summary ?? existing.data.summary,
		description: options.description ?? existing.data.description,
		location: options.location ?? existing.data.location,
		start: options.start
			? {
					dateTime: options.start,
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}
			: existing.data.start,
		end: options.end
			? {
					dateTime: options.end,
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}
			: existing.data.end,
		attendees: options.attendees
			? options.attendees.map((email) => ({ email }))
			: existing.data.attendees,
	};

	const response = await calendar.events.update({
		calendarId: options.calendarId || "primary",
		eventId,
		requestBody: event,
		sendUpdates: "all",
	});

	return convertEvent(response.data);
}

/**
 * Delete a calendar event.
 */
export async function deleteEvent(
	auth: OAuth2Client,
	eventId: string,
	calendarId = "primary",
): Promise<void> {
	const calendar = google.calendar({ version: "v3", auth });

	await calendar.events.delete({
		calendarId,
		eventId,
		sendUpdates: "all", // Notify attendees
	});
}

/**
 * Query free/busy information for multiple calendars.
 *
 * Automatically includes the authenticated user's calendar
 * alongside the provided attendee emails so the result
 * reflects everyone's availability. Deduplicates if the
 * user's email is already in the list.
 */
export async function queryFreeBusy(
	auth: OAuth2Client,
	options: {
		emails: string[];
		timeMin: string; // ISO datetime
		timeMax: string; // ISO datetime
		timeZone?: string;
	},
): Promise<FreeBusyResult> {
	const calendar = google.calendar({ version: "v3", auth });
	const userEmail = await resolveUserEmail(auth);

	// We build the items list, always including the user's
	// calendar and deduplicating if their email was already
	// passed as an attendee.
	const seen = new Set<string>();
	const items: Array<{ id: string }> = [{ id: "primary" }];
	if (userEmail) seen.add(userEmail.toLowerCase());

	for (const email of options.emails) {
		const lower = email.toLowerCase();
		if (!seen.has(lower)) {
			seen.add(lower);
			items.push({ id: email });
		}
	}

	const response = await calendar.freebusy.query({
		requestBody: {
			timeMin: new Date(options.timeMin).toISOString(),
			timeMax: new Date(options.timeMax).toISOString(),
			timeZone:
				options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
			items,
		},
	});

	const rawCalendars = response.data.calendars ?? {};
	const calendars: CalendarFreeBusy[] = [];

	for (const [id, data] of Object.entries(rawCalendars)) {
		const busy: BusyPeriod[] = (data.busy ?? []).map((period) => ({
			start: period.start ?? "",
			end: period.end ?? "",
		}));

		const errors = (data.errors ?? []).map(
			(e) => e.reason ?? e.domain ?? "unknown",
		);

		const isSelf =
			id === "primary" ||
			(userEmail !== undefined && id.toLowerCase() === userEmail.toLowerCase());

		calendars.push({
			email: isSelf ? (userEmail ?? "you") : id,
			busy,
			self: isSelf || undefined,
			errors: errors.length > 0 ? errors : undefined,
		});
	}

	return {
		timeMin: response.data.timeMin ?? options.timeMin,
		timeMax: response.data.timeMax ?? options.timeMax,
		calendars,
	};
}

/** Resolve the authenticated user's email from their OAuth token. */
async function resolveUserEmail(
	auth: OAuth2Client,
): Promise<string | undefined> {
	try {
		const tokenInfo = await auth.getTokenInfo(
			auth.credentials.access_token || "",
		);
		return tokenInfo.email;
	} catch {
		// Token info fetch is non-critical; we proceed without it.
		return undefined;
	}
}

/**
 * Respond to a calendar event invitation.
 */
export async function respondToEvent(
	auth: OAuth2Client,
	eventId: string,
	response: "accepted" | "declined" | "tentative",
	calendarId = "primary",
): Promise<CalendarEvent> {
	const calendar = google.calendar({ version: "v3", auth });

	// We get the existing event.
	const existing = await calendar.events.get({
		calendarId,
		eventId,
	});

	// We find our attendance entry and update the response.
	const attendees = existing.data.attendees || [];
	for (const attendee of attendees) {
		if (attendee.self) {
			attendee.responseStatus = response;
		}
	}

	const updated = await calendar.events.update({
		calendarId,
		eventId,
		requestBody: {
			...existing.data,
			attendees,
		},
		sendUpdates: "all",
	});

	return convertEvent(updated.data);
}
