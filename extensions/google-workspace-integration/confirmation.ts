/**
 * Confirmation gates for sensitive Google Workspace operations.
 * Uses prompt() with actions for approve/cancel decisions.
 * Redirect annotations return feedback for the agent to adjust.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type PromptResult,
	promptSingle,
	wordWrap,
} from "../../lib/ui/index.js";
import { formatRedirectReason } from "../../lib/ui/redirect.js";

/** Email fields presented to the user for confirmation before sending. */
export interface EmailData {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
}

/** Calendar event fields presented to the user for confirmation before creating or updating. */
export interface EventData {
	summary: string;
	start: string;
	end: string;
	description?: string;
	location?: string;
	attendees?: string[];
}

/** Result from a confirmation gate: approved data, redirect feedback, or null (cancelled). */
export type ConfirmResult<T> =
	| { approved: true; data: T }
	| { approved: false; redirect: string }
	| null;

/** Reject action shared by non-destructive confirmation gates. */
const REJECT_ACTION = [{ key: "r", label: "Reject" }];

/** Extract redirect feedback from a prompt result, or null if not a redirect. */
function extractRedirect(
	result: PromptResult | null,
	context: string,
): { approved: false; redirect: string } | null {
	if (!result) return null;
	if (result.type === "redirect") {
		return {
			approved: false,
			redirect: formatRedirectReason(result.note ?? "", context),
		};
	}
	if (result.note) {
		return {
			approved: false,
			redirect: formatRedirectReason(result.note, context),
		};
	}
	return null;
}

/**
 * Confirm email before sending.
 * Returns approved data, redirect feedback, or null if cancelled.
 */
export async function confirmSendEmail(
	ctx: ExtensionContext,
	email: EmailData,
	isReply: boolean,
): Promise<ConfirmResult<EmailData>> {
	if (!ctx.hasUI) return { approved: true, data: email };

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
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
			const wrapWidth = Math.max(20, width - 2);
			for (const line of email.body.split("\n")) {
				for (const wrapped of wordWrap(line, wrapWidth)) {
					lines.push(` ${wrapped}`);
				}
			}
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;
	const emailContext = `Original email to: ${email.to.join(", ")}\nSubject: ${email.subject}`;
	const redirect = extractRedirect(result, emailContext);
	if (redirect) return redirect;
	if (result.type === "action" && result.key === "r") {
		return {
			approved: false,
			redirect: formatRedirectReason(
				"User rejected the email. Ask what to change.",
				emailContext,
			),
		};
	}
	return { approved: true, data: email };
}

/**
 * Confirm deleting an email.
 * Returns approved true, redirect feedback, or null if cancelled.
 */
export async function confirmDeleteEmail(
	ctx: ExtensionContext,
	messageId: string,
	subject?: string,
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };

	const result = await promptSingle(ctx, {
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
		actions: [{ key: "d", label: "Delete" }],
	});

	if (!result) return null;
	const redirect = extractRedirect(
		result,
		`Delete email ${subject ? `"${subject}"` : messageId}`,
	);
	if (redirect) return redirect;
	// Only the explicit Delete key triggers deletion (destructive).
	if (result.type === "action" && result.key === "d") {
		return { approved: true, data: true };
	}
	return null;
}

/**
 * Confirm event before creating (only when attendees present).
 * Returns approved data, redirect feedback, or null if cancelled.
 */
export async function confirmCreateEvent(
	ctx: ExtensionContext,
	event: EventData,
): Promise<ConfirmResult<EventData>> {
	if (!ctx.hasUI) return { approved: true, data: event };
	if (!event.attendees || event.attendees.length === 0) {
		return { approved: true, data: event };
	}

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
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
				const wrapWidth = Math.max(20, width - 2);
				lines.push("");
				lines.push(` ${theme.fg("muted", "Description:")}`);
				for (const line of event.description.split("\n")) {
					for (const wrapped of wordWrap(line, wrapWidth)) {
						lines.push(` ${wrapped}`);
					}
				}
			}
			lines.push("");
			lines.push(" Invitations will be sent to all attendees.");
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;
	const eventContext = `Create event: ${event.summary}\nAttendees: ${event.attendees.join(", ")}`;
	const redirect = extractRedirect(result, eventContext);
	if (redirect) return redirect;
	if (result.type === "action" && result.key === "r") {
		return {
			approved: false,
			redirect: formatRedirectReason(
				"User rejected the event. Ask what to change.",
				eventContext,
			),
		};
	}
	return { approved: true, data: event };
}

/**
 * Confirm updating an event with attendees.
 * Returns approved true, redirect feedback, or null if cancelled.
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
	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Update Calendar Event")),
				"",
			];
			lines.push(` ${theme.fg("muted", "Event:")} ${existingEvent.summary}`);
			lines.push(` ${theme.fg("muted", "ID:")} \`${eventId}\``);
			if (changes.length > 0) {
				lines.push("");
				lines.push(" **Changes:**");
				for (const change of changes) {
					lines.push(` - ${change}`);
				}
			}
			if (updates.description) {
				const wrapWidth = Math.max(20, width - 2);
				lines.push("");
				lines.push(` ${theme.fg("muted", "Description:")}`);
				for (const line of updates.description.split("\n")) {
					for (const wrapped of wordWrap(line, wrapWidth)) {
						lines.push(` ${wrapped}`);
					}
				}
			}
			lines.push("");
			lines.push(" Attendees will be notified of the changes.");
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;
	const updateContext = `Update event: ${existingEvent.summary}\nChanges: ${changes.join(", ")}`;
	const redirect = extractRedirect(result, updateContext);
	if (redirect) return redirect;
	if (result.type === "action" && result.key === "r") {
		return {
			approved: false,
			redirect: formatRedirectReason(
				"User rejected the update. Ask what to change.",
				updateContext,
			),
		};
	}
	return { approved: true, data: true };
}

/**
 * Confirm deleting an event with attendees.
 * Returns approved true, redirect feedback, or null if cancelled.
 */
export async function confirmDeleteEvent(
	ctx: ExtensionContext,
	eventId: string,
	summary: string,
	hasAttendees: boolean,
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };
	if (!hasAttendees) return { approved: true, data: true };

	const result = await promptSingle(ctx, {
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
		actions: [{ key: "d", label: "Delete" }],
	});

	if (!result) return null;
	const redirect = extractRedirect(result, `Delete event: ${summary}`);
	if (redirect) return redirect;
	// Only the explicit Delete key triggers deletion (destructive).
	if (result.type === "action" && result.key === "d") {
		return { approved: true, data: true };
	}
	return null;
}
