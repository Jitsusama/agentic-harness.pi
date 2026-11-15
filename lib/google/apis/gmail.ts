/**
 * Gmail API client.
 */

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import type { EmailMessage, EmailMessageFull } from "../types.ts";
import { google } from "./client.ts";

/** A message as Gmail answers one. */
type GmailMessage = gmail_v1.Schema$Message;

/** One part of a message's payload, which may hold parts of its own. */
type GmailPart = gmail_v1.Schema$MessagePart;

/** What a new message says: who it goes to, about what, and its body. */
interface Composed {
	to: string[];
	subject: string;
	body: string;
	cc?: string[];
	bcc?: string[];
}

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

	// We fetch metadata for each message.
	const messages: EmailMessage[] = [];
	for (const { id } of messageIds) {
		if (!id) continue;

		const msg = await gmail.users.messages.get({
			userId: "me",
			id,
			format: "metadata",
			metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
		});

		messages.push(readMessage(msg.data));
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

	return readFullMessage(msg.data);
}

/**
 * Get an email thread.
 */
export async function getThread(
	auth: OAuth2Client,
	messageId: string,
): Promise<EmailMessageFull[]> {
	const gmail = google.gmail({ version: "v1", auth });

	// We first get the message to find its thread ID.
	const msg = await gmail.users.messages.get({
		userId: "me",
		id: messageId,
		format: "minimal",
	});

	const threadId = msg.data.threadId;
	if (!threadId) {
		throw new Error("Message has no thread ID");
	}

	// We get the full thread.
	const thread = await gmail.users.threads.get({
		userId: "me",
		id: threadId,
		format: "full",
	});

	return (thread.data.messages || []).map(readFullMessage);
}

/**
 * Send an email.
 */
export async function sendEmail(
	auth: OAuth2Client,
	options: Composed & {
		replyTo?: string; // Message ID to reply to
	},
): Promise<{ id: string; threadId: string }> {
	const gmail = google.gmail({ version: "v1", auth });

	// If replying, we add headers and fetch the original message.
	const replyHeaders: string[] = [];
	let threadId: string | undefined;
	if (options.replyTo) {
		const original = await gmail.users.messages.get({
			userId: "me",
			id: options.replyTo,
			format: "metadata",
			metadataHeaders: ["Message-ID", "References"],
		});

		const messageIdHeader = headerOf(original.data, "Message-ID");
		const referencesHeader = headerOf(original.data, "References");

		if (messageIdHeader) {
			replyHeaders.push(`In-Reply-To: ${messageIdHeader}`);
			replyHeaders.push(
				`References: ${referencesHeader ? `${referencesHeader} ` : ""}${messageIdHeader}`,
			);
		}

		threadId = original.data.threadId || undefined;
	}

	const result = await gmail.users.messages.send({
		userId: "me",
		requestBody: {
			raw: encodeMessage(options, replyHeaders),
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
	options: Composed,
): Promise<{ id: string; messageId: string }> {
	const gmail = google.gmail({ version: "v1", auth });

	const result = await gmail.users.drafts.create({
		userId: "me",
		requestBody: {
			message: {
				raw: encodeMessage(options),
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
	await relabel(auth, messageId, { removeLabelIds: ["INBOX"] });
}

/**
 * Unarchive an email (add INBOX label back).
 */
export async function unarchiveEmail(
	auth: OAuth2Client,
	messageId: string,
): Promise<void> {
	await relabel(auth, messageId, { addLabelIds: ["INBOX"] });
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
	await relabel(auth, messageId, { removeLabelIds: ["UNREAD"] });
}

/**
 * Mark an email as unread.
 */
export async function markUnread(
	auth: OAuth2Client,
	messageId: string,
): Promise<void> {
	await relabel(auth, messageId, { addLabelIds: ["UNREAD"] });
}

/** Add or remove labels on one message, leaving the rest as they are. */
async function relabel(
	auth: OAuth2Client,
	messageId: string,
	change: gmail_v1.Schema$ModifyMessageRequest,
): Promise<void> {
	const gmail = google.gmail({ version: "v1", auth });

	await gmail.users.messages.modify({
		userId: "me",
		id: messageId,
		requestBody: change,
	});
}

/** What every reader of a message sees: its headers, labels and snippet. */
function readMessage(msg: GmailMessage): EmailMessage {
	const cc = headerOf(msg, "Cc");
	return {
		id: msg.id || "",
		threadId: msg.threadId || "",
		subject: headerOf(msg, "Subject") || "(no subject)",
		from: parseEmailAddress(headerOf(msg, "From")),
		to: parseEmailAddresses(headerOf(msg, "To")),
		cc: cc ? parseEmailAddresses(cc) : undefined,
		date: headerOf(msg, "Date"),
		snippet: msg.snippet || "",
		labels: msg.labelIds || [],
		hasAttachments: hasAttachments(msg.payload),
	};
}

/** A message as a full read sees it, with its body and attachments. */
function readFullMessage(msg: GmailMessage): EmailMessageFull {
	return {
		...readMessage(msg),
		body: extractBody(msg.payload),
		attachments: extractAttachments(msg.payload),
	};
}

/** One header's value, matched without regard to case; empty if absent. */
function headerOf(msg: GmailMessage, name: string): string {
	const wanted = name.toLowerCase();
	return (
		msg.payload?.headers?.find((h) => h.name?.toLowerCase() === wanted)
			?.value || ""
	);
}

/**
 * A message as Gmail takes one: its headers, a blank line and its body,
 * in URL-safe base64 without padding.
 */
function encodeMessage(message: Composed, extraHeaders: string[] = []): string {
	const headers = [
		`To: ${message.to.join(", ")}`,
		...(message.cc ? [`Cc: ${message.cc.join(", ")}`] : []),
		...(message.bcc ? [`Bcc: ${message.bcc.join(", ")}`] : []),
		`Subject: ${message.subject}`,
		...extraHeaders,
	];
	return Buffer.from([...headers, "", message.body].join("\n"))
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/[=]+$/, "");
}

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

function hasAttachments(payload: GmailPart | undefined): boolean {
	return (payload?.parts ?? []).some((part) => Boolean(part.filename));
}

function extractBody(payload: GmailPart | undefined): string {
	if (!payload) return "";

	// If there's a body.data, we decode it.
	if (payload.body?.data) {
		return decodeBase64(payload.body.data);
	}

	const parts = payload.parts;
	if (!parts) return "";

	// We prefer plain text, and fall back to HTML if there's none.
	const plain = partData(parts, "text/plain");
	if (plain) return decodeBase64(plain);
	const html = partData(parts, "text/html");
	if (html) return stripHtml(decodeBase64(html));

	// We recurse into multipart parts.
	for (const part of parts) {
		const body = extractBody(part);
		if (body) return body;
	}

	return "";
}

/** The encoded body of the first part of one type that has one. */
function partData(parts: GmailPart[], mimeType: string): string | undefined {
	return (
		parts.find((part) => part.mimeType === mimeType && part.body?.data)
			?.body?.data ?? undefined
	);
}

function extractAttachments(
	payload: GmailPart | undefined,
): Array<{ filename: string; mimeType: string; size: number }> {
	return (payload?.parts ?? []).flatMap((part) =>
		part.filename
			? [
					{
						filename: part.filename,
						mimeType: part.mimeType || "application/octet-stream",
						size: part.body?.size || 0,
					},
				]
			: [],
	);
}

function decodeBase64(data: string): string {
	try {
		// Gmail uses URL-safe base64.
		const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
		return Buffer.from(base64, "base64").toString("utf-8");
	} catch {
		// Base64 decoding failed (malformed data), so we return an empty string.
		return "";
	}
}

function stripHtml(html: string): string {
	// This is very basic HTML stripping: we just remove the tags.
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
