/**
 * Calendar action handlers.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
import {
	createEvent,
	deleteEvent,
	getEvent,
	listEvents,
	respondToEvent,
	updateEvent,
} from "../apis/calendar.js";
import {
	confirmCreateEvent,
	confirmDeleteEvent,
	confirmUpdateEvent,
} from "../confirmation.js";
import { renderEvent, renderEventList } from "../renderers/calendar.js";
import {
	type ActionParams,
	getNumberParam,
	getStringArrayParam,
	getStringParam,
	type ToolResult,
} from "../types.js";

export async function handleListEvents(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const start = getStringParam(params, "start");
	const end = getStringParam(params, "end");
	const calendarId = getStringParam(params, "calendar_id");
	const limit = getNumberParam(params, "limit");

	const events = await listEvents(auth, {
		start,
		end,
		calendarId,
		maxResults: limit,
	});

	return {
		content: [{ type: "text", text: renderEventList(events) }],
		details: { events },
	};
}

export async function handleGetEvent(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const eventId = getStringParam(params, "event_id");
	const calendarId = getStringParam(params, "calendar_id");

	if (!eventId) {
		return {
			content: [{ type: "text", text: "Missing required parameter: event_id" }],
		};
	}

	const event = await getEvent(auth, eventId, calendarId);
	return {
		content: [{ type: "text", text: renderEvent(event) }],
		details: { event },
	};
}

export async function handleCreateEvent(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const summary = getStringParam(params, "summary");
	const start = getStringParam(params, "start");
	const end = getStringParam(params, "end");
	const description = getStringParam(params, "description");
	const location = getStringParam(params, "location");
	const attendees = getStringArrayParam(params, "attendees");
	const calendarId = getStringParam(params, "calendar_id");

	if (!summary || !start || !end) {
		return {
			content: [
				{
					type: "text",
					text: "Missing required parameters: summary, start, end",
				},
			],
		};
	}

	// We confirm and potentially let the user edit before creating.
	const confirmResult = await confirmCreateEvent(ctx, {
		summary,
		start,
		end,
		description,
		location,
		attendees,
	});

	if (!confirmResult) {
		return {
			content: [{ type: "text", text: "✗ Event creation cancelled" }],
		};
	}
	if (!confirmResult.approved) {
		return {
			content: [{ type: "text", text: confirmResult.redirect }],
		};
	}

	try {
		const eventData = confirmResult.data;
		const event = await createEvent(auth, {
			summary: eventData.summary,
			start: eventData.start,
			end: eventData.end,
			description: eventData.description,
			location: eventData.location,
			attendees: eventData.attendees,
			calendarId,
		});

		return {
			content: [
				{ type: "text", text: `✓ Event created\n\n${renderEvent(event)}` },
			],
			details: { event },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [
				{
					type: "text",
					text: `Failed to create event: ${message}\n\nProvided times:\n- Start: ${eventData.start}\n- End: ${eventData.end}`,
				},
			],
		};
	}
}

export async function handleUpdateEvent(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const eventId = getStringParam(params, "event_id");
	const summary = getStringParam(params, "summary");
	const start = getStringParam(params, "start");
	const end = getStringParam(params, "end");
	const description = getStringParam(params, "description");
	const location = getStringParam(params, "location");
	const attendees = getStringArrayParam(params, "attendees");
	const calendarId = getStringParam(params, "calendar_id");

	if (!eventId) {
		return {
			content: [{ type: "text", text: "Missing required parameter: event_id" }],
		};
	}

	// We get the existing event to check if it has attendees
	const existing = await getEvent(auth, eventId, calendarId);
	const hasAttendees = existing.attendees && existing.attendees.length > 0;

	// We confirm if it has attendees.
	if (hasAttendees) {
		const confirmResult = await confirmUpdateEvent(ctx, eventId, existing, {
			summary,
			start,
			end,
			description,
			location,
			attendees,
		});

		if (!confirmResult) {
			return {
				content: [{ type: "text", text: "✗ Event update cancelled" }],
			};
		}
		if (!confirmResult.approved) {
			return {
				content: [{ type: "text", text: confirmResult.redirect }],
			};
		}
	}

	const event = await updateEvent(auth, eventId, {
		summary,
		start,
		end,
		description,
		location,
		attendees,
		calendarId,
	});

	return {
		content: [
			{ type: "text", text: `✓ Event updated\n\n${renderEvent(event)}` },
		],
		details: { event },
	};
}

export async function handleDeleteEvent(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const eventId = getStringParam(params, "event_id");
	const calendarId = getStringParam(params, "calendar_id");

	if (!eventId) {
		return {
			content: [{ type: "text", text: "Missing required parameter: event_id" }],
		};
	}

	// We get the existing event to check if it has attendees
	const existing = await getEvent(auth, eventId, calendarId);
	const hasAttendees = existing.attendees && existing.attendees.length > 0;

	// We confirm if it has attendees.
	if (hasAttendees) {
		const confirmResult = await confirmDeleteEvent(
			ctx,
			eventId,
			existing.summary,
			true,
		);

		if (!confirmResult) {
			return {
				content: [{ type: "text", text: "✗ Event deletion cancelled" }],
			};
		}
		if (!confirmResult.approved) {
			return {
				content: [{ type: "text", text: confirmResult.redirect }],
			};
		}
	}

	await deleteEvent(auth, eventId, calendarId);
	return {
		content: [{ type: "text", text: "✓ Event deleted" }],
	};
}

export async function handleRespondToEvent(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const eventId = getStringParam(params, "event_id");
	const response = getStringParam(params, "response");
	const calendarId = getStringParam(params, "calendar_id");

	if (!eventId || !response) {
		return {
			content: [
				{
					type: "text",
					text: "Missing required parameters: event_id, response",
				},
			],
		};
	}

	const event = await respondToEvent(
		auth,
		eventId,
		response as "accepted" | "declined" | "tentative",
		calendarId,
	);

	return {
		content: [
			{
				type: "text",
				text: `✓ Response sent: ${response}\n\n${renderEvent(event)}`,
			},
		],
		details: { event },
	};
}
