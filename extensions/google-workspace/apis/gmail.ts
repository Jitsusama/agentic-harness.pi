/**
 * Gmail API client.
 */

import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type { EmailMessage, EmailMessageFull } from "../types.js";

/**
 * Search emails using Gmail query syntax.
 */
export async function searchEmails(
	auth: OAuth2Client,
	query: string,
	limit = 25,
	pageToken?: string,
): Promise<{ messages: EmailMessage[]; nextPageToken?: string }> {
	const gmail = google.gmail({ version: "v1", auth });

	const listResponse = await gmail.users.messages.list({
		userId: "me",
		q: query,
		maxResults: limit,
		pageToken,
	});

	const messageIds = listResponse.data.messages || [];
	if (messageIds.length === 0) {
		return { messages: [] };
	}

	// Fetch metadata for each message
	const messages: EmailMessage[] = [];
	for (const { id } of messageIds) {
		if (!id) continue;

		const msg = await gmail.users.messages.get({
			userId: "me",
			id,
			format: "metadata",
			metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
		});

		const headers = msg.data.payload?.headers || [];
		const getHeader = (name: string) =>
			headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
				?.value || "";

		messages.push({
			id: msg.data.id || "",
			threadId: msg.data.threadId || "",
			subject: getHeader("Subject") || "(no subject)",
			from: parseEmailAddress(getHeader("From")),
			to: parseEmailAddresses(getHeader("To")),
			cc: getHeader("Cc") ? parseEmailAddresses(getHeader("Cc")) : undefined,
			date: getHeader("Date"),
			snippet: msg.data.snippet || "",
			labels: msg.data.labelIds || [],
			hasAttachments: hasAttachments(msg.data.payload),
		});
	}

	return {
		messages,
		nextPageToken: listResponse.data.nextPageToken || undefined,
	};
}

/**
 * Get a single email by ID.
 */
export async function getEmail(
	auth: OAuth2Client,
	messageId: string,
	format: "full" | "metadata" | "minimal" = "full",
): Promise<EmailMessageFull> {
	const gmail = google.gmail({ version: "v1", auth });

	const msg = await gmail.users.messages.get({
		userId: "me",
		id: messageId,
		format,
	});

	const headers = msg.data.payload?.headers || [];
	const getHeader = (name: string) =>
		headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ||
		"";

	const message: EmailMessageFull = {
		id: msg.data.id || "",
		threadId: msg.data.threadId || "",
		subject: getHeader("Subject") || "(no subject)",
		from: parseEmailAddress(getHeader("From")),
		to: parseEmailAddresses(getHeader("To")),
		cc: getHeader("Cc") ? parseEmailAddresses(getHeader("Cc")) : undefined,
		date: getHeader("Date"),
		snippet: msg.data.snippet || "",
		labels: msg.data.labelIds || [],
		hasAttachments: hasAttachments(msg.data.payload),
		body: extractBody(msg.data.payload),
		attachments: extractAttachments(msg.data.payload),
	};

	return message;
}

/**
 * Get an email thread.
 */
export async function getThread(
	auth: OAuth2Client,
	messageId: string,
): Promise<EmailMessageFull[]> {
	const gmail = google.gmail({ version: "v1", auth });

	// First get the message to find its thread ID
	const msg = await gmail.users.messages.get({
		userId: "me",
		id: messageId,
		format: "minimal",
	});

	const threadId = msg.data.threadId;
	if (!threadId) {
		throw new Error("Message has no thread ID");
	}

	// Get the full thread
	const thread = await gmail.users.threads.get({
		userId: "me",
		id: threadId,
		format: "full",
	});

	const messages: EmailMessageFull[] = [];
	for (const msgData of thread.data.messages || []) {
		const headers = msgData.payload?.headers || [];
		const getHeader = (name: string) =>
			headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
				?.value || "";

		messages.push({
			id: msgData.id || "",
			threadId: msgData.threadId || "",
			subject: getHeader("Subject") || "(no subject)",
			from: parseEmailAddress(getHeader("From")),
			to: parseEmailAddresses(getHeader("To")),
			cc: getHeader("Cc") ? parseEmailAddresses(getHeader("Cc")) : undefined,
			date: getHeader("Date"),
			snippet: msgData.snippet || "",
			labels: msgData.labelIds || [],
			hasAttachments: hasAttachments(msgData.payload),
			body: extractBody(msgData.payload),
			attachments: extractAttachments(msgData.payload),
		});
	}

	return messages;
}

// Helper functions

function parseEmailAddress(header: string): { name: string; email: string } {
	const match = header.match(/^(.*?)\s*<(.+?)>$/);
	if (match) {
		return {
			name: match[1]?.trim().replace(/^["']|["']$/g, "") || "",
			email: match[2]?.trim() || "",
		};
	}
	return { name: "", email: header.trim() };
}

function parseEmailAddresses(
	header: string,
): Array<{ name: string; email: string }> {
	if (!header) return [];
	return header.split(",").map((addr) => parseEmailAddress(addr.trim()));
}

function hasAttachments(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const parts = (payload as { parts?: unknown[] }).parts;
	if (!parts) return false;

	return parts.some((part) => {
		if (
			typeof part === "object" &&
			part !== null &&
			"filename" in part &&
			part.filename
		) {
			return true;
		}
		return false;
	});
}

function extractBody(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";

	const p = payload as {
		mimeType?: string;
		body?: { data?: string };
		parts?: unknown[];
	};

	// If there's a body.data, decode it
	if (p.body?.data) {
		return decodeBase64(p.body.data);
	}

	// If there are parts, recursively search for text/plain or text/html
	if (p.parts) {
		for (const part of p.parts) {
			if (typeof part !== "object" || part === null) continue;
			const partObj = part as {
				mimeType?: string;
				body?: { data?: string };
				parts?: unknown[];
			};

			if (partObj.mimeType === "text/plain" && partObj.body?.data) {
				return decodeBase64(partObj.body.data);
			}
		}

		// Fall back to HTML if no plain text
		for (const part of p.parts) {
			if (typeof part !== "object" || part === null) continue;
			const partObj = part as {
				mimeType?: string;
				body?: { data?: string };
				parts?: unknown[];
			};

			if (partObj.mimeType === "text/html" && partObj.body?.data) {
				return stripHtml(decodeBase64(partObj.body.data));
			}
		}

		// Recurse into multipart parts
		for (const part of p.parts) {
			const body = extractBody(part);
			if (body) return body;
		}
	}

	return "";
}

function extractAttachments(
	payload: unknown,
): Array<{ filename: string; mimeType: string; size: number }> {
	if (!payload || typeof payload !== "object") return [];

	const attachments: Array<{
		filename: string;
		mimeType: string;
		size: number;
	}> = [];
	const p = payload as { parts?: unknown[] };

	if (!p.parts) return [];

	for (const part of p.parts) {
		if (typeof part !== "object" || part === null) continue;
		const partObj = part as {
			filename?: string;
			mimeType?: string;
			body?: { size?: number };
		};

		if (partObj.filename) {
			attachments.push({
				filename: partObj.filename,
				mimeType: partObj.mimeType || "application/octet-stream",
				size: partObj.body?.size || 0,
			});
		}
	}

	return attachments;
}

function decodeBase64(data: string): string {
	try {
		// Gmail uses URL-safe base64
		const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
		return Buffer.from(base64, "base64").toString("utf-8");
	} catch (_error) {
		// Base64 decoding failed (malformed data) - return empty string
		return "";
	}
}

function stripHtml(html: string): string {
	// Very basic HTML stripping - just remove tags
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.trim();
}

// ---- Write Operations ----

/**
 * Send an email.
 */
export async function sendEmail(
	auth: OAuth2Client,
	options: {
		to: string[];
		subject: string;
		body: string;
		cc?: string[];
		bcc?: string[];
		replyTo?: string; // Message ID to reply to
	},
): Promise<{ id: string; threadId: string }> {
	const gmail = google.gmail({ version: "v1", auth });

	// Build email message
	const headers = [
		`To: ${options.to.join(", ")}`,
		...(options.cc ? [`Cc: ${options.cc.join(", ")}`] : []),
		...(options.bcc ? [`Bcc: ${options.bcc.join(", ")}`] : []),
		`Subject: ${options.subject}`,
	];

	// If replying, add headers and fetch original message
	let threadId: string | undefined;
	if (options.replyTo) {
		const original = await gmail.users.messages.get({
			userId: "me",
			id: options.replyTo,
			format: "metadata",
			metadataHeaders: ["Message-ID", "References"],
		});

		const messageIdHeader = original.data.payload?.headers?.find(
			(h) => h.name?.toLowerCase() === "message-id",
		)?.value;
		const referencesHeader = original.data.payload?.headers?.find(
			(h) => h.name?.toLowerCase() === "references",
		)?.value;

		if (messageIdHeader) {
			headers.push(`In-Reply-To: ${messageIdHeader}`);
			headers.push(
				`References: ${referencesHeader ? `${referencesHeader} ` : ""}${messageIdHeader}`,
			);
		}

		threadId = original.data.threadId || undefined;
	}

	const message = [...headers, "", options.body].join("\n");

	// Encode message
	const encodedMessage = Buffer.from(message)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	const result = await gmail.users.messages.send({
		userId: "me",
		requestBody: {
			raw: encodedMessage,
			threadId,
		},
	});

	return {
		id: result.data.id || "",
		threadId: result.data.threadId || "",
	};
}

/**
 * Create a draft email.
 */
export async function createDraft(
	auth: OAuth2Client,
	options: {
		to: string[];
		subject: string;
		body: string;
		cc?: string[];
		bcc?: string[];
	},
): Promise<{ id: string; messageId: string }> {
	const gmail = google.gmail({ version: "v1", auth });

	const headers = [
		`To: ${options.to.join(", ")}`,
		...(options.cc ? [`Cc: ${options.cc.join(", ")}`] : []),
		...(options.bcc ? [`Bcc: ${options.bcc.join(", ")}`] : []),
		`Subject: ${options.subject}`,
	];

	const message = [...headers, "", options.body].join("\n");

	const encodedMessage = Buffer.from(message)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	const result = await gmail.users.drafts.create({
		userId: "me",
		requestBody: {
			message: {
				raw: encodedMessage,
			},
		},
	});

	return {
		id: result.data.id || "",
		messageId: result.data.message?.id || "",
	};
}

/**
 * Archive an email (remove INBOX label).
 */
export async function archiveEmail(
	auth: OAuth2Client,
	messageId: string,
): Promise<void> {
	const gmail = google.gmail({ version: "v1", auth });

	await gmail.users.messages.modify({
		userId: "me",
		id: messageId,
		requestBody: {
			removeLabelIds: ["INBOX"],
		},
	});
}

/**
 * Delete an email (move to trash).
 */
export async function deleteEmail(
	auth: OAuth2Client,
	messageId: string,
): Promise<void> {
	const gmail = google.gmail({ version: "v1", auth });

	await gmail.users.messages.trash({
		userId: "me",
		id: messageId,
	});
}

/**
 * Mark an email as read.
 */
export async function markRead(
	auth: OAuth2Client,
	messageId: string,
): Promise<void> {
	const gmail = google.gmail({ version: "v1", auth });

	await gmail.users.messages.modify({
		userId: "me",
		id: messageId,
		requestBody: {
			removeLabelIds: ["UNREAD"],
		},
	});
}

/**
 * Mark an email as unread.
 */
export async function markUnread(
	auth: OAuth2Client,
	messageId: string,
): Promise<void> {
	const gmail = google.gmail({ version: "v1", auth });

	await gmail.users.messages.modify({
		userId: "me",
		id: messageId,
		requestBody: {
			addLabelIds: ["UNREAD"],
		},
	});
}
