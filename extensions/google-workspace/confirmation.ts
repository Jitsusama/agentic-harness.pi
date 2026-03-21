/**
 * Confirmation gates for sensitive Google Workspace operations.
 * Uses prompt() with actions for approve/cancel decisions.
 * Steer annotations return feedback for the agent to adjust.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { prompt } from "../lib/ui/panel.js";
import { formatSteer } from "../lib/ui/steer.js";

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

/** Result from a confirmation gate: approved data, steer feedback, or null (cancelled). */
export type ConfirmResult<T> =
	| { approved: true; data: T }
	| { approved: false; steer: string }
	| null;

// ---- Helpers ----

/** Extract steer feedback from a prompt result, or null if not a steer. */
function extractSteer(
	result: { type: string; note?: string; value?: string } | null,
	context: string,
): { approved: false; steer: string } | null {
	if (!result) return null;
	if (result.type === "steer") {
		return {
			approved: false,
			steer: formatSteer(result.note ?? "", context).reason,
		};
	}
	if (result.note) {
		return {
			approved: false,
			steer: formatSteer(result.note, context).reason,
		};
	}
	return null;
}

// ---- Email ----

/**
 * Confirm email before sending.
 * Returns approved data, steer feedback, or null if cancelled.
 */
export async function confirmSendEmail(
	ctx: ExtensionContext,
	email: EmailData,
	isReply: boolean,
): Promise<ConfirmResult<EmailData>> {
	if (!ctx.hasUI) return { approved: true, data: email };

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
	const steer = extractSteer(
		result,
		`Original email to: ${email.to.join(", ")}\nSubject: ${email.subject}`,
	);
	if (steer) return steer;
	return { approved: true, data: email };
}

/**
 * Confirm deleting an email.
 * Returns approved true, steer feedback, or null if cancelled.
 */
export async function confirmDeleteEmail(
	ctx: ExtensionContext,
	messageId: string,
	subject?: string,
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };

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

	if (!result || (result.type === "action" && result.value === "c")) {
		return null;
	}
	const steer = extractSteer(
		result,
		`Delete email ${subject ? `"${subject}"` : messageId}`,
	);
	if (steer) return steer;
	return { approved: true, data: true };
}

// ---- Calendar ----

/**
 * Confirm event before creating (only when attendees present).
 * Returns approved data, steer feedback, or null if cancelled.
 */
export async function confirmCreateEvent(
	ctx: ExtensionContext,
	event: EventData,
): Promise<ConfirmResult<EventData>> {
	if (!ctx.hasUI) return { approved: true, data: event };
	if (!event.attendees || event.attendees.length === 0) {
		return { approved: true, data: event };
	}

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
	const steer = extractSteer(
		result,
		`Create event: ${event.summary}\nAttendees: ${event.attendees.join(", ")}`,
	);
	if (steer) return steer;
	return { approved: true, data: event };
}

/**
 * Confirm updating an event with attendees.
 * Returns approved true, steer feedback, or null if cancelled.
 */
export async function confirmUpdateEvent(
	ctx: ExtensionContext,
	eventId: string,
	existingEvent: EventData,
	updates: Partial<EventData>,
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };
	if (!existingEvent.attendees || existingEvent.attendees.length === 0) {
		return { approved: true, data: true };
	}

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

	if (!result || (result.type === "action" && result.value === "c")) {
		return null;
	}
	const steer = extractSteer(
		result,
		`Update event: ${existingEvent.summary}\nChanges: ${changes.join(", ")}`,
	);
	if (steer) return steer;
	return { approved: true, data: true };
}

/**
 * Confirm deleting an event with attendees.
 * Returns approved true, steer feedback, or null if cancelled.
 */
export async function confirmDeleteEvent(
	ctx: ExtensionContext,
	eventId: string,
	summary: string,
	hasAttendees: boolean,
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };
	if (!hasAttendees) return { approved: true, data: true };

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

	if (!result || (result.type === "action" && result.value === "c")) {
		return null;
	}
	const steer = extractSteer(result, `Delete event: ${summary}`);
	if (steer) return steer;
	return { approved: true, data: true };
}
