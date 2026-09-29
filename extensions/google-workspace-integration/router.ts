/**
 * Routes incoming Google Workspace tool actions to the
 * appropriate API handlers (Gmail, Calendar, Drive).
 *
 * Each action maps to a handler function via a registry.
 * The handler type accepts all three dependencies (params,
 * auth, ctx) so handlers that need fewer just ignore the rest.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bounded as clocked } from "@jitsusama/agentic-harness.core/clock";
import type {
	ActionParams,
	ToolResult,
} from "@jitsusama/agentic-harness.core/google/types";
import {
	boundedByDetails,
	openSessionStore,
} from "@jitsusama/agentic-harness.core/result";
import type { OAuth2Client } from "google-auth-library";
import { GOOGLE_READ_WALL_MS } from "./limits.ts";
import {
	handleCheckAvailability,
	handleCreateEvent,
	handleDeleteEvent,
	handleGetEvent,
	handleListEvents,
	handleRespondToEvent,
	handleUpdateEvent,
} from "./router/calendar-handlers.ts";
import {
	handleGetFile,
	handleListFiles,
	handleListSharedDrives,
} from "./router/drive-handlers.ts";
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
} from "./router/gmail-handlers.ts";

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

/**
 * The actions that only read.
 *
 * A read is safe to walk away from, so it answers a stop at once and
 * is held to a clock across all its requests. A write is not: a stop
 * cannot say whether it landed, so it runs to Google's answer, which
 * core's request clock bounds. Every confirmation gate sits on a write,
 * so a gate is never left on screen by a read that was stopped.
 */
const READS = new Set([
	"search_emails",
	"get_email",
	"get_thread",
	"list_events",
	"get_event",
	"check_availability",
	"list_files",
	"get_file",
	"list_shared_drives",
]);

/**
 * Route a tool action to the appropriate handler. A read ends when the
 * signal fires or its clock runs out; a write runs to its answer.
 */
export async function routeAction(
	action: string,
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
	signal?: AbortSignal,
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
	const work = handler(params, auth, ctx);
	const answer = READS.has(action)
		? await clocked(work, {
				...(signal ? { signal } : {}),
				wallMs: GOOGLE_READ_WALL_MS,
				what: `Google's answer to ${action}`,
			})
		: await work;
	return bounded(answer);
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
