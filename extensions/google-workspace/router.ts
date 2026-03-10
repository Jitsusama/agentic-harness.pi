/**
 * Action router for Google Workspace tool.
 * Routes tool actions to appropriate API handlers.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
import {
	handleCreateEvent,
	handleDeleteEvent,
	handleGetEvent,
	handleListEvents,
	handleRespondToEvent,
	handleUpdateEvent,
} from "./router/calendar-handlers.js";
import {
	handleGetFile,
	handleListFiles,
	handleListSharedDrives,
} from "./router/drive-handlers.js";
import {
	handleArchiveEmail,
	handleCreateDraft,
	handleDeleteEmail,
	handleGetEmail,
	handleGetThread,
	handleMarkRead,
	handleMarkUnread,
	handleSearchEmails,
	handleSendEmail,
} from "./router/gmail-handlers.js";
import type { ActionParams, ToolResult } from "./types.js";

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
