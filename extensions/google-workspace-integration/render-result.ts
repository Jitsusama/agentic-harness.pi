/**
 * Render tool result display for Google Workspace actions.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { count, drawInto, firstText } from "../../lib/ui/index.js";

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
	freeBusy?: {
		calendars?: Array<{
			email?: string;
			busy?: Array<{ start?: string; end?: string }>;
			errors?: string[];
		}>;
	};
	id?: string;
	nextPageToken?: string;
}

/**
 * A result as pi hands it to a renderer.
 *
 * Blocks are text or image, and only text carries text, so the
 * first block is narrowed rather than read for a field it may not
 * have. This used to describe every block as optionally having
 * text, which typechecked against nothing pi actually passes.
 */
interface RenderableResult {
	content?: readonly ({ type: "text"; text: string } | { type: string })[];
	details?: unknown;
}

/** The text of a result's first block, when it has one. */
const leadingText = (result: RenderableResult): string => firstText(result);

/**
 * Render a Google Workspace tool result with action-specific formatting.
 */
export function renderGoogleResult(
	result: RenderableResult,
	options: RenderOptions,
	theme: Theme,
	reuse?: unknown,
): Text {
	return drawInto(reuse, resultText(result, options, theme));
}

/**
 * The whole answer as one presentation string.
 *
 * Separate from the component so the shapes below can compose freely.
 * They used to build a `Text` each, which meant every one of them had
 * to be told about reuse for a single row to be redrawn correctly, and
 * a helper that formats an email list has no business knowing what a
 * component is.
 */
function resultText(
	result: RenderableResult,
	options: RenderOptions,
	theme: Theme,
): string {
	const d = result.details as ResultDetails | undefined;
	const textContent = leadingText(result);

	// We check for errors.
	if (
		textContent.startsWith("Google Workspace API error:") ||
		textContent.startsWith("Missing required parameter")
	) {
		const errorMsg =
			textContent.length > 100
				? `${textContent.slice(0, 100)}...`
				: textContent;
		return theme.fg("error", errorMsg);
	}

	// We check for cancellations.
	if (
		textContent.startsWith("✗") ||
		textContent.includes("cancelled") ||
		textContent.includes("canceled")
	) {
		return theme.fg("warning", textContent.split("\n")[0]);
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
		return theme.fg("success", textContent.split("\n")[0]);
	}

	// Email operations
	if (
		textContent.startsWith("✓ Email archived") ||
		textContent.startsWith("✓ Email moved to inbox") ||
		textContent.startsWith("✓ Email deleted") ||
		textContent.startsWith("✓ Marked as")
	) {
		return theme.fg("success", textContent);
	}

	// Free/busy results
	if (d?.freeBusy) {
		return renderFreeBusyResult(d.freeBusy, options, theme);
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
		return theme.fg("success", textContent.split("\n")[0]);
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
		const drives = Array.isArray(d.drives) ? d.drives.length : 0;
		return theme.fg("success", `✓ ${count(drives, "shared drive")}`);
	}

	// Generic success
	if (textContent.startsWith("✓")) {
		return theme.fg("success", textContent.split("\n")[0]);
	}

	// Fallback
	return theme.fg("success", "✓");
}

function renderEmailList(
	messages: Array<{
		subject?: string;
		from?: string | { name?: string; email?: string };
	}>,
	nextPageToken: string | undefined,
	options: RenderOptions,
	theme: Theme,
): string {
	const total = messages.length;
	let summary = theme.fg("success", `✓ ${count(total, "message")}`);
	if (nextPageToken) {
		summary += theme.fg("muted", " (more available)");
	}

	if (!options.expanded && total > 0) {
		// Compact view shows a few subject lines as a preview.
		const previews = messages
			.slice(0, 3)
			.map((msg) => {
				const from = formatSender(msg.from);
				const subject = msg.subject || "(no subject)";
				return `  ${theme.fg("dim", `${from}: ${subject}`)}`;
			})
			.join("\n");
		if (total > 3) {
			return `${summary}\n${previews}\n  ${theme.fg("muted", `... ${total - 3} more`)}`;
		}
		return `${summary}\n${previews}`;
	}

	return summary;
}

function renderSingleEmail(
	message: {
		subject?: string;
		from?: string | { name?: string; email?: string };
	},
	theme: Theme,
): string {
	const subject = message.subject || "(no subject)";
	const from = formatSender(message.from);
	return `${theme.fg("success", "✓ Email")} ${theme.fg("dim", from)}\n  ${theme.fg("muted", subject)}`;
}

/**
 * Format sender for display (handles both string and object formats).
 */
function formatSender(
	from: string | { name?: string; email?: string } | undefined,
): string {
	if (!from) return "Unknown";
	if (typeof from === "string") return from;
	// The from field is an object, so we prefer the name and fall back to email.
	return from.name || from.email || "Unknown";
}

function renderEventList(
	events: Array<{ summary?: string; start?: { dateTime?: string } }>,
	options: RenderOptions,
	theme: Theme,
): string {
	const total = events.length;
	const summary = theme.fg("success", `✓ ${count(total, "event")}`);

	if (!options.expanded && total > 0) {
		// Compact view shows a few event titles as a preview.
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
		if (total > 3) {
			return `${summary}\n${previews}\n  ${theme.fg("muted", `... ${total - 3} more`)}`;
		}
		return `${summary}\n${previews}`;
	}

	return summary;
}

function renderSingleEvent(
	event: { summary?: string },
	textContent: string,
	theme: Theme,
): string {
	const summary = event.summary || "(no title)";
	const action = textContent.startsWith("✓ Event created")
		? "created"
		: textContent.startsWith("✓ Event updated")
			? "updated"
			: "loaded";
	return `${theme.fg("success", `✓ Event ${action}`)} ${theme.fg("dim", summary)}`;
}

function renderFileList(
	files: Array<{ name?: string; mimeType?: string }>,
	nextPageToken: string | undefined,
	options: RenderOptions,
	theme: Theme,
): string {
	const total = files.length;
	let summary = theme.fg("success", `✓ ${count(total, "file")}`);
	if (nextPageToken) {
		summary += theme.fg("muted", " (more available)");
	}

	if (!options.expanded && total > 0) {
		// Compact view shows a few file names as a preview.
		const previews = files
			.slice(0, 3)
			.map((file) => {
				const name = file.name || "Untitled";
				const type = file.mimeType?.split(".").pop() || "";
				return `  ${theme.fg("dim", type ? `[${type}] ${name}` : name)}`;
			})
			.join("\n");
		if (total > 3) {
			return `${summary}\n${previews}\n  ${theme.fg("muted", `... ${total - 3} more`)}`;
		}
		return `${summary}\n${previews}`;
	}

	return summary;
}

function renderFreeBusyResult(
	freeBusy: NonNullable<ResultDetails["freeBusy"]>,
	options: RenderOptions,
	theme: Theme,
): string {
	const calendars = freeBusy.calendars ?? [];
	const calCount = calendars.length;

	// We count the free slots by looking at calendars without errors.
	const allBusy = calendars
		.filter((c) => !c.errors || c.errors.length === 0)
		.flatMap((c) => c.busy ?? []);

	const busyCount = allBusy.length;
	const summary = theme.fg(
		"success",
		`✓ ${count(calCount, "calendar")} checked`,
	);

	const busyInfo = theme.fg("dim", ` · ${count(busyCount, "busy block")}`);

	if (!options.expanded && calendars.length > 0) {
		const previews = calendars
			.slice(0, 3)
			.map((cal) => {
				const name = cal.email || "Unknown";
				const busy = cal.busy?.length ?? 0;
				const status =
					cal.errors && cal.errors.length > 0
						? "⚠️ error"
						: busy === 0
							? "free"
							: `${busy} busy`;
				return `  ${theme.fg("dim", `${name}: ${status}`)}`;
			})
			.join("\n");

		if (calendars.length > 3) {
			return `${summary}${busyInfo}\n${previews}\n  ${theme.fg("muted", `... ${calendars.length - 3} more`)}`;
		}
		return `${summary}${busyInfo}\n${previews}`;
	}

	return `${summary}${busyInfo}`;
}

function renderSingleFile(
	file: { name?: string; mimeType?: string },
	theme: Theme,
): string {
	const name = file.name || "Untitled";
	const type = file.mimeType?.includes("document")
		? "Doc"
		: file.mimeType?.includes("spreadsheet")
			? "Sheet"
			: file.mimeType?.includes("presentation")
				? "Slides"
				: "File";
	return `${theme.fg("success", `✓ ${type}`)} ${theme.fg("dim", name)}`;
}
