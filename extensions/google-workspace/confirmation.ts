/**
 * Confirmation gates for sensitive Google Workspace operations.
 * Uses editable fields like PR/issue/commit guardians.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { reviewLoop, titleBodyField } from "../lib/guardian/review-loop.js";

export interface EmailData {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
}

export interface EventData {
	summary: string;
	start: string;
	end: string;
	description?: string;
	location?: string;
	attendees?: string[];
}

/**
 * Confirm and potentially edit email before sending.
 * Returns updated email data or null if cancelled.
 */
export async function confirmSendEmail(
	ctx: ExtensionContext,
	email: EmailData,
	isReply: boolean,
): Promise<EmailData | null> {
	if (!ctx.hasUI) return email;

	const field = titleBodyField(
		email.subject,
		email.body,
		isReply ? "Edit reply:" : "Edit email:",
	);

	const result = await reviewLoop(ctx, {
		actions: [
			{ label: "Send", value: "approve" },
			{ label: "Edit", value: "edit" },
			{ label: "Cancel", value: "reject" },
		],
		content: (theme, _width) => {
			const lines = [
				theme.fg(
					"accent",
					theme.bold(isReply ? " Reply to Email" : " Send Email"),
				),
				"",
			];
			lines.push(` ${theme.fg("muted", "To:")} ${email.to.join(", ")}`);
			if (email.cc && email.cc.length > 0) {
				lines.push(` ${theme.fg("muted", "Cc:")} ${email.cc.join(", ")}`);
			}
			if (email.bcc && email.bcc.length > 0) {
				lines.push(` ${theme.fg("muted", "Bcc:")} ${email.bcc.join(", ")}`);
			}
			lines.push("");
			lines.push(
				` ${theme.fg("muted", "Subject:")} ${field.title || email.subject}`,
			);
			lines.push("");
			const bodyLines = (field.body || email.body).split("\n");
			const preview = bodyLines.slice(0, 15);
			for (const line of preview) {
				lines.push(` ${line}`);
			}
			if (bodyLines.length > 15) {
				lines.push(
					` ${theme.fg("dim", `... (${bodyLines.length - 15} more lines)`)}`,
				);
			}
			return lines;
		},
		field,
		entityName: "email",
		steerContext: `To: ${email.to.join(", ")}\nSubject: ${email.subject}\n\n${email.body}`,
	});

	// User cancelled or rejected
	if (result) return null;

	// Return potentially edited email
	return {
		...email,
		subject: field.title || email.subject,
		body: field.body,
	};
}

/**
 * Confirm deleting an email.
 */
export async function confirmDeleteEmail(
	ctx: ExtensionContext,
	messageId: string,
	subject?: string,
): Promise<boolean> {
	if (!ctx.hasUI) return true;

	const result = await reviewLoop(ctx, {
		actions: [
			{ label: "Delete", value: "approve" },
			{ label: "Cancel", value: "reject" },
		],
		content: (theme, _width) => {
			const lines = [theme.fg("accent", theme.bold(" Delete Email")), ""];
			if (subject) {
				lines.push(` ${theme.fg("muted", "Subject:")} ${subject}`);
			}
			lines.push(` ${theme.fg("muted", "ID:")} \`${messageId}\``);
			lines.push("");
			lines.push(
				" This will move the email to trash (recoverable for 30 days).",
			);
			return lines;
		},
		entityName: "email deletion",
		steerContext: `Delete email: ${subject || messageId}`,
	});

	return !result; // null/undefined = approved, anything else = blocked
}

/**
 * Confirm and potentially edit event before creating.
 */
export async function confirmCreateEvent(
	ctx: ExtensionContext,
	event: EventData,
): Promise<EventData | null> {
	if (!ctx.hasUI) return event;
	if (!event.attendees || event.attendees.length === 0) return event; // No confirmation for personal events

	const field = titleBodyField(
		event.summary,
		event.description || "",
		"Edit event:",
	);

	const result = await reviewLoop(ctx, {
		actions: [
			{ label: "Create", value: "approve" },
			{ label: "Edit", value: "edit" },
			{ label: "Cancel", value: "reject" },
		],
		content: (theme, _width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Create Calendar Event")),
				"",
			];
			lines.push(
				` ${theme.fg("muted", "Title:")} ${field.title || event.summary}`,
			);
			lines.push(
				` ${theme.fg("muted", "When:")} ${event.start} – ${event.end}`,
			);
			if (event.location) {
				lines.push(` ${theme.fg("muted", "Where:")} ${event.location}`);
			}
			lines.push(
				` ${theme.fg("muted", "Attendees:")} ${event.attendees.join(", ")}`,
			);
			if (field.body) {
				lines.push("");
				lines.push(` ${theme.fg("muted", "Description:")}`);
				for (const line of field.body.split("\n").slice(0, 5)) {
					lines.push(` ${line}`);
				}
			}
			lines.push("");
			lines.push(" Invitations will be sent to all attendees.");
			return lines;
		},
		field,
		entityName: "calendar event",
		steerContext: `Event: ${event.summary}\nAttendees: ${event.attendees.join(", ")}`,
	});

	if (result) return null;

	return {
		...event,
		summary: field.title || event.summary,
		description: field.body || event.description,
	};
}

/**
 * Confirm updating an event with attendees.
 */
export async function confirmUpdateEvent(
	ctx: ExtensionContext,
	eventId: string,
	existingEvent: EventData,
	updates: Partial<EventData>,
): Promise<boolean> {
	if (!ctx.hasUI) return true;
	if (!existingEvent.attendees || existingEvent.attendees.length === 0)
		return true;

	const changes: string[] = [];
	if (updates.summary) changes.push(`Title: ${updates.summary}`);
	if (updates.start || updates.end)
		changes.push(`Time: ${updates.start} – ${updates.end}`);
	if (updates.location) changes.push(`Location: ${updates.location}`);
	if (updates.attendees)
		changes.push(`Attendees: ${updates.attendees.join(", ")}`);
	if (updates.description) changes.push("Description updated");

	const result = await reviewLoop(ctx, {
		actions: [
			{ label: "Update", value: "approve" },
			{ label: "Cancel", value: "reject" },
		],
		content: (theme, _width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Update Calendar Event")),
				"",
			];
			lines.push(` ${theme.fg("muted", "Event:")} ${existingEvent.summary}`);
			lines.push(` ${theme.fg("muted", "ID:")} \`${eventId}\``);
			lines.push("");
			lines.push(" **Changes:**");
			for (const change of changes) {
				lines.push(` - ${change}`);
			}
			lines.push("");
			lines.push(" Attendees will be notified of the changes.");
			return lines;
		},
		entityName: "calendar event update",
		steerContext: `Update event: ${existingEvent.summary}\nChanges: ${changes.join(", ")}`,
	});

	return !result;
}

/**
 * Confirm deleting an event with attendees.
 */
export async function confirmDeleteEvent(
	ctx: ExtensionContext,
	eventId: string,
	summary: string,
	hasAttendees: boolean,
): Promise<boolean> {
	if (!ctx.hasUI) return true;
	if (!hasAttendees) return true;

	const result = await reviewLoop(ctx, {
		actions: [
			{ label: "Delete", value: "approve" },
			{ label: "Cancel", value: "reject" },
		],
		content: (theme, _width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Delete Calendar Event")),
				"",
			];
			lines.push(` ${theme.fg("muted", "Event:")} ${summary}`);
			lines.push(` ${theme.fg("muted", "ID:")} \`${eventId}\``);
			lines.push("");
			lines.push(" Attendees will be notified of the cancellation.");
			return lines;
		},
		entityName: "calendar event deletion",
		steerContext: `Delete event: ${summary}`,
	});

	return !result;
}
