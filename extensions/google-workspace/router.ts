/**
 * Action router for Google Workspace tool.
 * Routes tool actions to appropriate API handlers.
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
} from "./apis/calendar.js";
import { getDocComments, getDocContent } from "./apis/docs.js";
import {
	getFileMetadata,
	listFiles,
	listSharedDrives,
	parseGoogleUrl,
} from "./apis/drive.js";
import {
	archiveEmail,
	createDraft,
	deleteEmail,
	getEmail,
	getThread,
	markRead,
	markUnread,
	searchEmails,
	sendEmail,
} from "./apis/gmail.js";
import { getSheetContent } from "./apis/sheets.js";
import { getSlideContent } from "./apis/slides.js";
import {
	confirmCreateEvent,
	confirmDeleteEmail,
	confirmDeleteEvent,
	confirmSendEmail,
	confirmUpdateEvent,
} from "./confirmation.js";
import { renderEvent, renderEventList } from "./renderers/calendar.js";
import {
	renderDoc,
	renderFileList,
	renderSheet,
	renderSlides,
} from "./renderers/drive.js";
import {
	renderEmail,
	renderEmailList,
	renderThread,
} from "./renderers/email.js";
import type { ToolResult } from "./types.js";

/** Parameters passed to router actions. */
export type ActionParams = Record<string, unknown>;

/**
 * Route a tool action to the appropriate handler.
 */
export async function routeAction(
	action: string,
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	switch (action) {
		case "search_emails":
			return handleSearchEmails(params, auth);

		case "get_email":
			return handleGetEmail(params, auth);

		case "get_thread":
			return handleGetThread(params, auth);

		case "send_email":
			return handleSendEmail(params, auth, ctx);

		case "create_draft":
			return handleCreateDraft(params, auth);

		case "archive_email":
			return handleArchiveEmail(params, auth);

		case "delete_email":
			return handleDeleteEmail(params, auth, ctx);

		case "mark_read":
			return handleMarkRead(params, auth);

		case "mark_unread":
			return handleMarkUnread(params, auth);

		case "list_events":
			return handleListEvents(params, auth);

		case "get_event":
			return handleGetEvent(params, auth);

		case "create_event":
			return handleCreateEvent(params, auth, ctx);

		case "update_event":
			return handleUpdateEvent(params, auth, ctx);

		case "delete_event":
			return handleDeleteEvent(params, auth, ctx);

		case "respond_to_event":
			return handleRespondToEvent(params, auth);

		case "list_files":
			return handleListFiles(params, auth);

		case "get_file":
			return handleGetFile(params, auth);

		case "list_shared_drives":
			return handleListSharedDrives(auth);

		default:
			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
			};
	}
}

// ---- Gmail Handlers ----

async function handleSearchEmails(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const query = params.query as string | undefined;
	const limit = params.limit as number | undefined;
	const pageToken = params.page_token as string | undefined;

	if (!query) {
		return {
			content: [{ type: "text", text: "Missing required parameter: query" }],
		};
	}

	const result = await searchEmails(auth, query, limit, pageToken);
	return {
		content: [
			{
				type: "text",
				text: renderEmailList(result.messages, result.nextPageToken),
			},
		],
		details: result,
	};
}

async function handleGetEmail(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = params.id as string | undefined;

	if (!id) {
		return {
			content: [{ type: "text", text: "Missing required parameter: id" }],
		};
	}

	const message = await getEmail(auth, id);
	return {
		content: [{ type: "text", text: renderEmail(message) }],
		details: { message },
	};
}

async function handleGetThread(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const messageId = params.message_id as string | undefined;

	if (!messageId) {
		return {
			content: [
				{ type: "text", text: "Missing required parameter: message_id" },
			],
		};
	}

	const messages = await getThread(auth, messageId);
	return {
		content: [{ type: "text", text: renderThread(messages) }],
		details: { messages },
	};
}

async function handleSendEmail(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const to = params.to as string[] | undefined;
	const subject = params.subject as string | undefined;
	const body = params.body as string | undefined;
	const cc = params.cc as string[] | undefined;
	const bcc = params.bcc as string[] | undefined;
	const replyTo = params.reply_to as string | undefined;

	if (!to || !subject || !body) {
		return {
			content: [
				{
					type: "text",
					text: "Missing required parameters: to, subject, body",
				},
			],
		};
	}

	// Confirm and potentially edit before sending
	const emailData = await confirmSendEmail(
		ctx,
		{ to, cc, bcc, subject, body },
		!!replyTo,
	);

	if (!emailData) {
		return {
			content: [{ type: "text", text: "✗ Send email cancelled" }],
		};
	}

	const result = await sendEmail(auth, {
		to: emailData.to,
		subject: emailData.subject,
		body: emailData.body,
		cc: emailData.cc,
		bcc: emailData.bcc,
		replyTo,
	});

	return {
		content: [
			{ type: "text", text: `✓ Email sent\n\nMessage ID: \`${result.id}\`` },
		],
		details: result,
	};
}

async function handleCreateDraft(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const to = params.to as string[] | undefined;
	const subject = params.subject as string | undefined;
	const body = params.body as string | undefined;
	const cc = params.cc as string[] | undefined;
	const bcc = params.bcc as string[] | undefined;

	if (!to || !subject || !body) {
		return {
			content: [
				{
					type: "text",
					text: "Missing required parameters: to, subject, body",
				},
			],
		};
	}

	const result = await createDraft(auth, { to, subject, body, cc, bcc });
	return {
		content: [
			{ type: "text", text: `✓ Draft created\n\nDraft ID: \`${result.id}\`` },
		],
		details: result,
	};
}

async function handleArchiveEmail(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = params.id as string | undefined;

	if (!id) {
		return {
			content: [{ type: "text", text: "Missing required parameter: id" }],
		};
	}

	await archiveEmail(auth, id);
	return {
		content: [{ type: "text", text: "✓ Email archived" }],
	};
}

async function handleDeleteEmail(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const id = params.id as string | undefined;

	if (!id) {
		return {
			content: [{ type: "text", text: "Missing required parameter: id" }],
		};
	}

	// Confirm before deleting
	const confirmed = await confirmDeleteEmail(ctx, id);
	if (!confirmed) {
		return {
			content: [{ type: "text", text: "✗ Delete cancelled" }],
		};
	}

	await deleteEmail(auth, id);
	return {
		content: [{ type: "text", text: "✓ Email deleted" }],
	};
}

async function handleMarkRead(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = params.id as string | undefined;

	if (!id) {
		return {
			content: [{ type: "text", text: "Missing required parameter: id" }],
		};
	}

	await markRead(auth, id);
	return {
		content: [{ type: "text", text: "✓ Marked as read" }],
	};
}

async function handleMarkUnread(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = params.id as string | undefined;

	if (!id) {
		return {
			content: [{ type: "text", text: "Missing required parameter: id" }],
		};
	}

	await markUnread(auth, id);
	return {
		content: [{ type: "text", text: "✓ Marked as unread" }],
	};
}

// ---- Calendar Handlers ----

async function handleListEvents(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const start = params.start as string | undefined;
	const end = params.end as string | undefined;
	const calendarId = params.calendar_id as string | undefined;
	const limit = params.limit as number | undefined;

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

async function handleGetEvent(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const eventId = params.event_id as string | undefined;
	const calendarId = params.calendar_id as string | undefined;

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

async function handleCreateEvent(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const summary = params.summary as string | undefined;
	const start = params.start as string | undefined;
	const end = params.end as string | undefined;
	const description = params.description as string | undefined;
	const location = params.location as string | undefined;
	const attendees = params.attendees as string[] | undefined;
	const calendarId = params.calendar_id as string | undefined;

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

	// Confirm and potentially edit before creating
	const eventData = await confirmCreateEvent(ctx, {
		summary,
		start,
		end,
		description,
		location,
		attendees,
	});

	if (!eventData) {
		return {
			content: [{ type: "text", text: "✗ Event creation cancelled" }],
		};
	}

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
}

async function handleUpdateEvent(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const eventId = params.event_id as string | undefined;
	const summary = params.summary as string | undefined;
	const start = params.start as string | undefined;
	const end = params.end as string | undefined;
	const description = params.description as string | undefined;
	const location = params.location as string | undefined;
	const attendees = params.attendees as string[] | undefined;
	const calendarId = params.calendar_id as string | undefined;

	if (!eventId) {
		return {
			content: [{ type: "text", text: "Missing required parameter: event_id" }],
		};
	}

	// Get existing event to check if it has attendees
	const existing = await getEvent(auth, eventId, calendarId);
	const hasAttendees = existing.attendees && existing.attendees.length > 0;

	// Confirm if it has attendees
	if (hasAttendees) {
		const confirmed = await confirmUpdateEvent(ctx, eventId, existing, {
			summary,
			start,
			end,
			description,
			location,
			attendees,
		});

		if (!confirmed) {
			return {
				content: [{ type: "text", text: "✗ Event update cancelled" }],
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

async function handleDeleteEvent(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const eventId = params.event_id as string | undefined;
	const calendarId = params.calendar_id as string | undefined;

	if (!eventId) {
		return {
			content: [{ type: "text", text: "Missing required parameter: event_id" }],
		};
	}

	// Get existing event to check if it has attendees
	const existing = await getEvent(auth, eventId, calendarId);
	const hasAttendees = existing.attendees && existing.attendees.length > 0;

	// Confirm if it has attendees
	if (hasAttendees) {
		const confirmed = await confirmDeleteEvent(
			ctx,
			eventId,
			existing.summary,
			true,
		);

		if (!confirmed) {
			return {
				content: [{ type: "text", text: "✗ Event deletion cancelled" }],
			};
		}
	}

	await deleteEvent(auth, eventId, calendarId);
	return {
		content: [{ type: "text", text: "✓ Event deleted" }],
	};
}

async function handleRespondToEvent(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const eventId = params.event_id as string | undefined;
	const response = params.response as string | undefined;
	const calendarId = params.calendar_id as string | undefined;

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

// ---- Drive Handlers ----

async function handleListFiles(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const query = params.query as string | undefined;
	const folderId = params.folder_id as string | undefined;
	const type = params.type as string | undefined;
	const owner = params.owner as string | undefined;
	const shared = params.shared as boolean | undefined;
	const sharedDriveId = params.shared_drive_id as string | undefined;
	const orderBy = params.order_by as string | undefined;
	const limit = params.limit as number | undefined;
	const pageToken = params.page_token as string | undefined;

	const result = await listFiles(auth, {
		query,
		folderId,
		type: type as "doc" | "sheet" | "slides" | "folder" | "pdf" | undefined,
		owner,
		shared,
		sharedDriveId,
		orderBy: orderBy as "modifiedTime" | "name" | "relevance" | undefined,
		limit,
		pageToken,
	});

	return {
		content: [
			{
				type: "text",
				text: renderFileList(result.files, result.nextPageToken),
			},
		],
		details: result,
	};
}

async function handleGetFile(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = params.id as string | undefined;
	const url = params.url as string | undefined;
	const includeComments = params.include_comments as boolean | undefined;
	const commentsFilter = params.comments_filter as string | undefined;

	// Parse URL if provided
	let fileId = id;
	if (url && !fileId) {
		const parsed = parseGoogleUrl(url);
		if (!parsed) {
			return {
				content: [{ type: "text", text: `Could not parse Google URL: ${url}` }],
			};
		}
		fileId = parsed.id;
	}

	if (!fileId) {
		return {
			content: [
				{ type: "text", text: "Missing required parameter: id or url" },
			],
		};
	}

	// Get file metadata
	const file = await getFileMetadata(auth, fileId);
	const mime = file.mimeType;

	// Get comments if requested
	const comments = includeComments
		? await getDocComments(
				auth,
				fileId,
				commentsFilter as "all" | "resolved" | "unresolved" | undefined,
			)
		: undefined;

	// Route based on MIME type
	if (mime === "application/vnd.google-apps.document") {
		const content = await getDocContent(auth, fileId);
		return {
			content: [{ type: "text", text: renderDoc(file, content, comments) }],
			details: { file, content, comments },
		};
	}

	if (mime === "application/vnd.google-apps.spreadsheet") {
		const content = await getSheetContent(auth, fileId);
		return {
			content: [{ type: "text", text: renderSheet(file, content, comments) }],
			details: { file, content, comments },
		};
	}

	if (mime === "application/vnd.google-apps.presentation") {
		const content = await getSlideContent(auth, fileId);
		return {
			content: [{ type: "text", text: renderSlides(file, content, comments) }],
			details: { file, content, comments },
		};
	}

	// For other file types, just return metadata
	return {
		content: [
			{
				type: "text",
				text: `# ${file.name}\n\n- **Type:** ${file.mimeType}\n- **ID:** \`${file.id}\`\n- **Link:** ${file.webViewLink || "N/A"}`,
			},
		],
		details: { file },
	};
}

async function handleListSharedDrives(auth: OAuth2Client): Promise<ToolResult> {
	const drives = await listSharedDrives(auth);
	const lines = ["# Shared Drives\n"];
	for (const drive of drives) {
		lines.push(`- **${drive.name}** · \`${drive.id}\``);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { drives },
	};
}
