/**
 * Render tool call display for Google Workspace actions.
 */

import type { Theme } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";

interface RenderOptions {
	terminalWidth?: number;
	expanded?: boolean;
}

interface CallArgs {
	action?: string;
	query?: string;
	id?: string;
	to?: string[];
	subject?: string;
	summary?: string;
	start?: string;
	account?: string;
}

/**
 * Render a Google Workspace tool call with action-specific formatting.
 */
export function renderGoogleCall(
	args: unknown,
	options: RenderOptions,
	theme: Theme,
): Text {
	const a = args as CallArgs;
	const action = a.action || "?";
	let text = theme.fg("toolTitle", theme.bold("google "));

	// Show account if not default
	if (a.account && a.account !== "work") {
		text += theme.fg("dim", `[${a.account}] `);
	}

	// Action-specific formatting
	switch (action) {
		case "search_emails":
			text += "search_emails";
			if (a.query) {
				const preview =
					a.query.length > 40 ? `${a.query.slice(0, 40)}...` : a.query;
				text += theme.fg("dim", ` "${preview}"`);
			}
			break;

		case "get_email":
			text += "get_email";
			if (a.id) {
				const shortId = a.id.length > 12 ? `${a.id.slice(0, 12)}...` : a.id;
				text += theme.fg("muted", ` ${shortId}`);
			}
			break;

		case "get_thread":
			text += "get_thread";
			break;

		case "send_email":
			text += "send_email";
			if (a.to && a.to.length > 0) {
				const recipient = a.to[0];
				text += theme.fg("dim", ` → ${recipient}`);
				if (a.to.length > 1) {
					text += theme.fg("muted", ` +${a.to.length - 1}`);
				}
			}
			if (a.subject) {
				const maxWidth = options.terminalWidth ?? 80;
				const prefixLen = 30; // Approximate length of "google send_email → user@example.com "
				const availableWidth = maxWidth - prefixLen;
				const subjectPreview =
					a.subject.length > availableWidth
						? `${a.subject.slice(0, availableWidth - 3)}...`
						: a.subject;
				text += theme.fg("dim", `: ${subjectPreview}`);
			}
			break;

		case "create_draft":
			text += "create_draft";
			if (a.subject) {
				const preview =
					a.subject.length > 40 ? `${a.subject.slice(0, 40)}...` : a.subject;
				text += theme.fg("dim", ` "${preview}"`);
			}
			break;

		case "archive_email":
			text += "archive_email";
			break;

		case "unarchive_email":
			text += "unarchive_email";
			break;

		case "delete_email":
			text += "delete_email";
			break;

		case "mark_read":
			text += "mark_read";
			break;

		case "mark_unread":
			text += "mark_unread";
			break;

		case "list_events":
			text += "list_events";
			if (a.start) {
				text += theme.fg("dim", ` from ${a.start}`);
			}
			break;

		case "get_event":
			text += "get_event";
			break;

		case "create_event":
			text += "create_event";
			if (a.summary) {
				const preview =
					a.summary.length > 40 ? `${a.summary.slice(0, 40)}...` : a.summary;
				text += theme.fg("dim", ` "${preview}"`);
			}
			if (a.start) {
				text += theme.fg("muted", ` @ ${a.start}`);
			}
			break;

		case "update_event":
			text += "update_event";
			break;

		case "delete_event":
			text += "delete_event";
			break;

		case "respond_to_event":
			text += "respond_to_event";
			break;

		case "list_files":
			text += "list_files";
			if (a.query) {
				const preview =
					a.query.length > 40 ? `${a.query.slice(0, 40)}...` : a.query;
				text += theme.fg("dim", ` "${preview}"`);
			}
			break;

		case "get_file":
			text += "get_file";
			break;

		case "list_shared_drives":
			text += "list_shared_drives";
			break;

		default:
			text += action;
			if (a.query) {
				const preview =
					a.query.length > 40 ? `${a.query.slice(0, 40)}...` : a.query;
				text += theme.fg("dim", ` "${preview}"`);
			}
	}

	return new Text(text, 0, 0);
}
