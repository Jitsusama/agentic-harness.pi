/**
 * Gmail action handlers.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
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
	unarchiveEmail,
} from "../apis/gmail.js";
import { confirmDeleteEmail, confirmSendEmail } from "../confirmation.js";
import {
	renderEmail,
	renderEmailList,
	renderThread,
} from "../renderers/email.js";
import {
	type ActionParams,
	getNumberParam,
	getStringArrayParam,
	getStringParam,
	type ToolResult,
} from "../types.js";

/** Search Gmail messages using a query string. */
export async function handleSearchEmails(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const query = getStringParam(params, "query");
	const limit = getNumberParam(params, "limit");
	const pageToken = getStringParam(params, "page_token");

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

/** Fetch a single email message by ID. */
export async function handleGetEmail(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = getStringParam(params, "id");

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

/** Fetch all messages in an email thread. */
export async function handleGetThread(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const messageId = getStringParam(params, "message_id");

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

/** Send an email, with user confirmation before dispatching. */
export async function handleSendEmail(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const to = getStringArrayParam(params, "to");
	const subject = getStringParam(params, "subject");
	const body = getStringParam(params, "body");
	const cc = getStringArrayParam(params, "cc");
	const bcc = getStringArrayParam(params, "bcc");
	const replyTo = getStringParam(params, "reply_to");

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

	// We confirm and potentially let the user edit before sending.
	const confirmResult = await confirmSendEmail(
		ctx,
		{ to, cc, bcc, subject, body },
		!!replyTo,
	);

	if (!confirmResult) {
		return {
			content: [{ type: "text", text: "✗ Send email cancelled" }],
		};
	}
	if (!confirmResult.approved) {
		return {
			content: [{ type: "text", text: confirmResult.redirect }],
		};
	}

	const emailData = confirmResult.data;
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

/** Create a draft email without sending it. */
export async function handleCreateDraft(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const to = getStringArrayParam(params, "to");
	const subject = getStringParam(params, "subject");
	const body = getStringParam(params, "body");
	const cc = getStringArrayParam(params, "cc");
	const bcc = getStringArrayParam(params, "bcc");

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

/** Archive an email by removing it from the inbox. */
export async function handleArchiveEmail(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = getStringParam(params, "id");

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

/** Permanently delete an email, with user confirmation first. */
export async function handleDeleteEmail(
	params: ActionParams,
	auth: OAuth2Client,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const id = getStringParam(params, "id");

	if (!id) {
		return {
			content: [{ type: "text", text: "Missing required parameter: id" }],
		};
	}

	// We confirm before deleting.
	const confirmResult = await confirmDeleteEmail(ctx, id);
	if (!confirmResult) {
		return {
			content: [{ type: "text", text: "✗ Delete cancelled" }],
		};
	}
	if (!confirmResult.approved) {
		return {
			content: [{ type: "text", text: confirmResult.redirect }],
		};
	}

	await deleteEmail(auth, id);
	return {
		content: [{ type: "text", text: "✓ Email deleted" }],
	};
}

/** Mark an email as read. */
export async function handleMarkRead(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = getStringParam(params, "id");

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

/** Mark an email as unread. */
export async function handleMarkUnread(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = getStringParam(params, "id");

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

/** Move an archived email back to the inbox. */
export async function handleUnarchiveEmail(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = getStringParam(params, "id");

	if (!id) {
		return {
			content: [{ type: "text", text: "Missing required parameter: id" }],
		};
	}

	await unarchiveEmail(auth, id);
	return {
		content: [{ type: "text", text: "✓ Email moved to inbox" }],
	};
}
