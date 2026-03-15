/**
 * Confirmation gates for sensitive Google Workspace operations.
 * Uses prompt() with actions for approve/cancel decisions.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { prompt } from "../lib/ui/panel.js";

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
 * Confirm email before sending.
 * Returns email data if approved, or null if cancelled.
 */
export async function confirmSendEmail(
	ctx: ExtensionContext,
	email: EmailData,
	isReply: boolean,
): Promise<EmailData | null> {
	if (!ctx.hasUI) return email;

	const result = await prompt(ctx, {
		content: (theme) => {
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
			lines.push(` ${theme.fg("muted", "Subject:")} ${email.subject}`);
			lines.push("");
			const bodyLines = email.body.split("\n");
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
		actions: [
			{ key: "s", label: "Send" },
			{ key: "c", label: "Cancel" },
		],
	});

	if (!result || (result.type === "action" && result.value === "c")) {
		return null;
	}
	return email;
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

	const result = await prompt(ctx, {
		content: (theme) => {
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
		actions: [
			{ key: "d", label: "Delete" },
			{ key: "c", label: "Cancel" },
		],
	});

	return !!result && result.type === "action" && result.value === "d";
}

/**
 * Confirm event before creating (only when attendees present).
 */
export async function confirmCreateEvent(
	ctx: ExtensionContext,
	event: EventData,
): Promise<EventData | null> {
	if (!ctx.hasUI) return event;
	if (!event.attendees || event.attendees.length === 0) return event;

	const result = await prompt(ctx, {
		content: (theme) => {
			const lines = [
				theme.fg("accent", theme.bold(" Create Calendar Event")),
				"",
			];
			lines.push(` ${theme.fg("muted", "Title:")} ${event.summary}`);
			lines.push(
				` ${theme.fg("muted", "When:")} ${event.start} – ${event.end}`,
			);
			if (event.location) {
				lines.push(` ${theme.fg("muted", "Where:")} ${event.location}`);
			}
			lines.push(
				` ${theme.fg("muted", "Attendees:")} ${event.attendees.join(", ")}`,
			);
			if (event.description) {
				lines.push("");
				lines.push(` ${theme.fg("muted", "Description:")}`);
				for (const line of event.description.split("\n").slice(0, 5)) {
					lines.push(` ${line}`);
				}
			}
			lines.push("");
			lines.push(" Invitations will be sent to all attendees.");
			return lines;
		},
		actions: [
			{ key: "c", label: "Create" },
			{ key: "x", label: "Cancel" },
		],
	});

	if (!result || (result.type === "action" && result.value === "x")) {
		return null;
	}
	return event;
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

	const result = await prompt(ctx, {
		content: (theme) => {
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
		actions: [
			{ key: "u", label: "Update" },
			{ key: "c", label: "Cancel" },
		],
	});

	return !!result && result.type === "action" && result.value === "u";
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

	const result = await prompt(ctx, {
		content: (theme) => {
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
		actions: [
			{ key: "d", label: "Delete" },
			{ key: "c", label: "Cancel" },
		],
	});

	return !!result && result.type === "action" && result.value === "d";
}
