/**
 * Routes incoming Google Workspace tool actions to the
 * appropriate API handlers (Gmail, Calendar, Drive).
 *
 * Each action maps to a handler function via a registry.
 * The handler type accepts all three dependencies (params,
 * auth, ctx) so handlers that need fewer just ignore the rest.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	boundedByDetails,
	openSessionStore,
} from "@jitsusama/agentic-harness.core/result";
import type { OAuth2Client } from "google-auth-library";
import type { ActionParams, ToolResult } from "../../lib/google/types.js";
import {
	handleCheckAvailability,
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
	handleUnarchiveEmail,
} from "./router/gmail-handlers.js";

/** Handler function that processes a Google Workspace action. */
type ActionHandler = (
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
) => Promise<ToolResult>;

/** Registry mapping action names to their handlers. */
const ACTION_HANDLERS = new Map<string, ActionHandler>([
	["search_emails", handleSearchEmails],
	["get_email", handleGetEmail],
	["get_thread", handleGetThread],
	["send_email", handleSendEmail],
	["create_draft", handleCreateDraft],
	["archive_email", handleArchiveEmail],
	["unarchive_email", handleUnarchiveEmail],
	["delete_email", handleDeleteEmail],
	["mark_read", handleMarkRead],
	["mark_unread", handleMarkUnread],
	["list_events", handleListEvents],
	["get_event", handleGetEvent],
	["create_event", handleCreateEvent],
	["update_event", handleUpdateEvent],
	["delete_event", handleDeleteEvent],
	["respond_to_event", handleRespondToEvent],
	["check_availability", handleCheckAvailability],
	["list_files", handleListFiles],
	["get_file", handleGetFile],
	["list_shared_drives", (_params, auth) => handleListSharedDrives(auth)],
]);

/** Route a tool action to the appropriate handler. */
export async function routeAction(
	action: string,
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const handler = ACTION_HANDLERS.get(action);

	if (!handler) {
		return {
			content: [{ type: "text", text: `Unknown action: ${action}` }],
		};
	}

	// Every handler passes through here, so this is the one place the
	// family needs to keep an answer bounded. An email list, a
	// calendar sweep or a Drive listing can each be thousands of
	// records; a document body is one record and passes through
	// untouched.
	return bounded(await handler(params, auth, ctx));
}

/** How a caller asks Google Workspace for a smaller answer. */
const NARROWING =
	"Narrow with 'limit', a tighter 'query', or a shorter date range " +
	"through 'start' and 'end'.";

/**
 * Bound a result's first text block, citing the records its
 * details already carry.
 *
 * Only the first block is bounded because that is the rendered
 * listing; anything after it is attached content a caller asked
 * for by name, and half of an attachment is no use to anybody.
 */
function bounded(result: ToolResult): ToolResult {
	const [first, ...rest] = result.content;
	if (first === undefined || first.type !== "text") return result;
	const text = boundedByDetails(openSessionStore(), {
		text: first.text,
		details: result.details,
		narrowing: NARROWING,
	});
	if (text === first.text) return result;
	return { ...result, content: [{ type: "text", text }, ...rest] };
}
