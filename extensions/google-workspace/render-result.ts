/**
 * Render tool result display for Google Workspace actions.
 */

import type { Theme } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";

interface RenderOptions {
	terminalWidth?: number;
	expanded?: boolean;
}

interface ResultDetails {
	messages?: Array<{
		subject?: string;
		from?: string | { name?: string; email?: string };
	}>;
	message?: {
		subject?: string;
		from?: string | { name?: string; email?: string };
	};
	events?: Array<{ summary?: string; start?: { dateTime?: string } }>;
	event?: { summary?: string; start?: { dateTime?: string } };
	files?: Array<{ name?: string; mimeType?: string }>;
	file?: { name?: string; mimeType?: string };
	drives?: unknown[];
	id?: string;
	nextPageToken?: string;
}

interface ResultContent {
	text?: string;
}

interface ToolResult {
	content?: ResultContent[];
	details?: unknown;
}

/**
 * Render a Google Workspace tool result with action-specific formatting.
 */
export function renderGoogleResult(
	result: ToolResult,
	options: RenderOptions,
	theme: Theme,
): Text {
	const d = result.details as ResultDetails | undefined;
	const textContent = result.content?.[0]?.text || "";

	// Check for errors
	if (
		textContent.startsWith("Google Workspace API error:") ||
		textContent.startsWith("Missing required parameter")
	) {
		const errorMsg =
			textContent.length > 100
				? `${textContent.slice(0, 100)}...`
				: textContent;
		return new Text(theme.fg("error", errorMsg), 0, 0);
	}

	// Check for cancellations
	if (
		textContent.startsWith("✗") ||
		textContent.includes("cancelled") ||
		textContent.includes("canceled")
	) {
		return new Text(theme.fg("warning", textContent.split("\n")[0]), 0, 0);
	}

	// Gmail list results
	if (d?.messages && Array.isArray(d.messages)) {
		return renderEmailList(d.messages, d.nextPageToken, options, theme);
	}

	// Single email retrieved
	if (d?.message) {
		return renderSingleEmail(d.message, theme);
	}

	// Email sent/draft created
	if (
		textContent.startsWith("✓ Email sent") ||
		textContent.startsWith("✓ Draft created")
	) {
		return new Text(theme.fg("success", textContent.split("\n")[0]), 0, 0);
	}

	// Email operations
	if (
		textContent.startsWith("✓ Email archived") ||
		textContent.startsWith("✓ Email moved to inbox") ||
		textContent.startsWith("✓ Email deleted") ||
		textContent.startsWith("✓ Marked as")
	) {
		return new Text(theme.fg("success", textContent), 0, 0);
	}

	// Calendar list results
	if (d?.events && Array.isArray(d.events)) {
		return renderEventList(d.events, options, theme);
	}

	// Single event created/updated
	if (d?.event) {
		return renderSingleEvent(d.event, textContent, theme);
	}

	// Event operations
	if (
		textContent.startsWith("✓ Event deleted") ||
		textContent.startsWith("✓ Response sent")
	) {
		return new Text(theme.fg("success", textContent.split("\n")[0]), 0, 0);
	}

	// Drive file list results
	if (d?.files && Array.isArray(d.files)) {
		return renderFileList(d.files, d.nextPageToken, options, theme);
	}

	// Single file retrieved
	if (d?.file) {
		return renderSingleFile(d.file, theme);
	}

	// Shared drives list
	if (d?.drives) {
		const count = Array.isArray(d.drives) ? d.drives.length : 0;
		return new Text(
			theme.fg("success", `✓ ${count} shared drive${count !== 1 ? "s" : ""}`),
			0,
			0,
		);
	}

	// Generic success
	if (textContent.startsWith("✓")) {
		return new Text(theme.fg("success", textContent.split("\n")[0]), 0, 0);
	}

	// Fallback
	return new Text(theme.fg("success", "✓"), 0, 0);
}

function renderEmailList(
	messages: Array<{
		subject?: string;
		from?: string | { name?: string; email?: string };
	}>,
	nextPageToken: string | undefined,
	options: RenderOptions,
	theme: Theme,
): Text {
	const count = messages.length;
	let summary = theme.fg(
		"success",
		`✓ ${count} message${count !== 1 ? "s" : ""}`,
	);
	if (nextPageToken) {
		summary += theme.fg("muted", " (more available)");
	}

	if (!options.expanded && count > 0) {
		// Show subject lines in compact view
		const previews = messages
			.slice(0, 3)
			.map((msg) => {
				const from = formatSender(msg.from);
				const subject = msg.subject || "(no subject)";
				return `  ${theme.fg("dim", `${from}: ${subject}`)}`;
			})
			.join("\n");
		if (count > 3) {
			return new Text(
				`${summary}\n${previews}\n  ${theme.fg("muted", `... ${count - 3} more`)}`,
				0,
				0,
			);
		}
		return new Text(`${summary}\n${previews}`, 0, 0);
	}

	return new Text(summary, 0, 0);
}

function renderSingleEmail(
	message: {
		subject?: string;
		from?: string | { name?: string; email?: string };
	},
	theme: Theme,
): Text {
	const subject = message.subject || "(no subject)";
	const from = formatSender(message.from);
	return new Text(
		`${theme.fg("success", "✓ Email")} ${theme.fg("dim", from)}\n  ${theme.fg("muted", subject)}`,
		0,
		0,
	);
}

/**
 * Format sender for display (handles both string and object formats).
 */
function formatSender(
	from: string | { name?: string; email?: string } | undefined,
): string {
	if (!from) return "Unknown";
	if (typeof from === "string") return from;
	// from is an object - prefer name, fall back to email
	return from.name || from.email || "Unknown";
}

function renderEventList(
	events: Array<{ summary?: string; start?: { dateTime?: string } }>,
	options: RenderOptions,
	theme: Theme,
): Text {
	const count = events.length;
	const summary = theme.fg(
		"success",
		`✓ ${count} event${count !== 1 ? "s" : ""}`,
	);

	if (!options.expanded && count > 0) {
		// Show event titles in compact view
		const previews = events
			.slice(0, 3)
			.map((evt) => {
				const title = evt.summary || "(no title)";
				const time = evt.start?.dateTime
					? new Date(evt.start.dateTime).toLocaleString(undefined, {
							month: "short",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
						})
					: "";
				return `  ${theme.fg("dim", `${time ? `${time}: ` : ""}${title}`)}`;
			})
			.join("\n");
		if (count > 3) {
			return new Text(
				`${summary}\n${previews}\n  ${theme.fg("muted", `... ${count - 3} more`)}`,
				0,
				0,
			);
		}
		return new Text(`${summary}\n${previews}`, 0, 0);
	}

	return new Text(summary, 0, 0);
}

function renderSingleEvent(
	event: { summary?: string },
	textContent: string,
	theme: Theme,
): Text {
	const summary = event.summary || "(no title)";
	const action = textContent.startsWith("✓ Event created")
		? "created"
		: textContent.startsWith("✓ Event updated")
			? "updated"
			: "loaded";
	return new Text(
		`${theme.fg("success", `✓ Event ${action}`)} ${theme.fg("dim", summary)}`,
		0,
		0,
	);
}

function renderFileList(
	files: Array<{ name?: string; mimeType?: string }>,
	nextPageToken: string | undefined,
	options: RenderOptions,
	theme: Theme,
): Text {
	const count = files.length;
	let summary = theme.fg("success", `✓ ${count} file${count !== 1 ? "s" : ""}`);
	if (nextPageToken) {
		summary += theme.fg("muted", " (more available)");
	}

	if (!options.expanded && count > 0) {
		// Show file names in compact view
		const previews = files
			.slice(0, 3)
			.map((file) => {
				const name = file.name || "Untitled";
				const type = file.mimeType?.split(".").pop() || "";
				return `  ${theme.fg("dim", type ? `[${type}] ${name}` : name)}`;
			})
			.join("\n");
		if (count > 3) {
			return new Text(
				`${summary}\n${previews}\n  ${theme.fg("muted", `... ${count - 3} more`)}`,
				0,
				0,
			);
		}
		return new Text(`${summary}\n${previews}`, 0, 0);
	}

	return new Text(summary, 0, 0);
}

function renderSingleFile(
	file: { name?: string; mimeType?: string },
	theme: Theme,
): Text {
	const name = file.name || "Untitled";
	const type = file.mimeType?.includes("document")
		? "Doc"
		: file.mimeType?.includes("spreadsheet")
			? "Sheet"
			: file.mimeType?.includes("presentation")
				? "Slides"
				: "File";
	return new Text(
		`${theme.fg("success", `✓ ${type}`)} ${theme.fg("dim", name)}`,
		0,
		0,
	);
}
