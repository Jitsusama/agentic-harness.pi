/**
 * Confirmation gates for Slack write operations.
 *
 * Each gate shows the user what will happen and lets them
 * approve, reject, annotate or redirect — matching the
 * guardian pattern used elsewhere in the harness.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type KeyAction,
	promptSingle,
	promptTabbed,
	renderMarkdown,
} from "../../lib/ui/index.js";
import { formatRedirectReason } from "../../lib/ui/redirect.js";

/** File metadata for the upload confirmation gate. */
export interface FileInfo {
	name: string;
	size: number;
}

/** Table data passed from the router for gate previews. */
export interface TableParam {
	columns: string[];
	rows: string[][];
	column_settings?: unknown[];
}

/** Reject action shown in every confirmation gate. */
const REJECT_ACTION: KeyAction[] = [{ key: "r", label: "Reject" }];

/** Result from a confirmation gate. */
export type ConfirmResult<T> =
	| { approved: true; data: T }
	| { approved: false; redirect: string }
	| null;

/** Shorthand for a redirect result. */
function redirect(note: string, context: string): ConfirmResult<never> {
	return { approved: false, redirect: formatRedirectReason(note, context) };
}

/**
 * Confirm sending a message to a conversation.
 */
export async function confirmSendMessage(
	ctx: ExtensionContext,
	conversationName: string,
	text: string,
	table?: TableParam,
): Promise<ConfirmResult<{ text: string }>> {
	if (!ctx.hasUI) return { approved: true, data: { text } };

	const context = `Send message to ${conversationName}:\n${text.slice(0, 200)}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Send Slack Message")),
				"",
				` ${theme.fg("muted", "To:")} ${conversationName}`,
				"",
			];
			for (const line of renderMarkdown(text, theme, width)) {
				lines.push(line);
			}
			if (table) {
				lines.push("");
				for (const line of renderTablePreview(table, theme, width)) {
					lines.push(line);
				}
			}
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return redirect(result.note, context);
	}

	if (result.type === "action") {
		if (result.key === "r") {
			if (result.note) return redirect(result.note, context);
			return redirect("User rejected. Ask for guidance.", context);
		}
		// Enter (approve)
		if (result.note) return redirect(result.note, context);
		return { approved: true, data: { text } };
	}

	return { approved: true, data: { text } };
}

/**
 * Confirm replying to a thread.
 */
export async function confirmReply(
	ctx: ExtensionContext,
	conversationName: string,
	threadTs: string,
	text: string,
	table?: TableParam,
): Promise<ConfirmResult<{ text: string }>> {
	if (!ctx.hasUI) return { approved: true, data: { text } };

	const context = `Reply in ${conversationName} thread ${threadTs}:\n${text.slice(0, 200)}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Reply to Thread")),
				"",
				` ${theme.fg("muted", "In:")} ${conversationName}`,
				` ${theme.fg("muted", "Thread:")} ${threadTs}`,
				"",
			];
			for (const line of renderMarkdown(text, theme, width)) {
				lines.push(line);
			}
			if (table) {
				lines.push("");
				for (const line of renderTablePreview(table, theme, width)) {
					lines.push(line);
				}
			}
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return redirect(result.note, context);
	}

	if (result.type === "action") {
		if (result.key === "r") {
			if (result.note) return redirect(result.note, context);
			return redirect("User rejected. Ask for guidance.", context);
		}
		// Enter (approve)
		if (result.note) return redirect(result.note, context);
		return { approved: true, data: { text } };
	}

	return { approved: true, data: { text } };
}

/**
 * Confirm uploading files to a conversation.
 */
export async function confirmUploadFile(
	ctx: ExtensionContext,
	conversationName: string,
	files: FileInfo[],
	text?: string,
	threadTs?: string,
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };

	const context = `Upload ${files.length === 1 ? files[0].name : `${files.length} files`} to ${conversationName}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Upload File")),
				"",
				` ${theme.fg("muted", "To:")} ${conversationName}`,
			];
			if (threadTs) {
				lines.push(` ${theme.fg("muted", "Thread:")} ${threadTs}`);
			}
			lines.push("");
			for (const f of files) {
				lines.push(
					` 📄 ${f.name} ${theme.fg("dim", `(${formatBytes(f.size)})`)}`,
				);
			}
			if (text) {
				lines.push("");
				lines.push(` ${theme.fg("muted", "Comment:")}`);
				for (const line of renderMarkdown(text, theme, width)) {
					lines.push(line);
				}
			}
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return redirect(result.note, context);
	}

	if (result.type === "action") {
		if (result.key === "r") {
			if (result.note) return redirect(result.note, context);
			return redirect("User rejected. Ask for guidance.", context);
		}
		if (result.note) return redirect(result.note, context);
		return { approved: true, data: true };
	}

	return { approved: true, data: true };
}

// ── Table preview rendering ─────────────────────────────

/** Theme type from the promptSingle/promptTabbed content callback. */
interface GateTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * Render a table preview using box-drawing characters.
 *
 * Shows the mrkdwn source text (what the agent wrote) so
 * the user can verify the data before it's transformed
 * to Block Kit.
 */
function renderTablePreview(
	table: TableParam,
	theme: GateTheme,
	maxWidth: number,
): string[] {
	const allRows = [table.columns, ...table.rows];

	// Calculate column widths, capped to available space.
	const colCount = table.columns.length;
	const widths: number[] = [];
	for (let c = 0; c < colCount; c++) {
		let max = 0;
		for (const row of allRows) {
			max = Math.max(max, (row[c] ?? "").length);
		}
		widths.push(max);
	}

	// Cap total width to terminal. Shrink the widest column
	// if needed (3 chars overhead per column: " │ " separators
	// plus the outer "│ " and " │").
	const overhead = 1 + colCount * 3;
	const available = Math.max(maxWidth - overhead, colCount * 3);
	const totalWidth = widths.reduce((a, b) => a + b, 0);
	if (totalWidth > available) {
		const scale = available / totalWidth;
		for (let c = 0; c < colCount; c++) {
			widths[c] = Math.max(3, Math.floor(widths[c] * scale));
		}
	}

	// Parse alignment from column_settings.
	const aligns: ("left" | "center" | "right")[] = [];
	for (let c = 0; c < colCount; c++) {
		const s = table.column_settings?.[c] as
			| { align?: string }
			| null
			| undefined;
		if (s?.align === "right") aligns.push("right");
		else if (s?.align === "center") aligns.push("center");
		else aligns.push("left");
	}

	/** Pad and truncate a cell value to the column width. */
	function padCell(value: string, col: number): string {
		const w = widths[col];
		const truncated = value.length > w ? `${value.slice(0, w - 1)}…` : value;
		if (aligns[col] === "right") return truncated.padStart(w);
		if (aligns[col] === "center") {
			const pad = w - truncated.length;
			const left = Math.floor(pad / 2);
			return " ".repeat(left) + truncated + " ".repeat(pad - left);
		}
		return truncated.padEnd(w);
	}

	function formatRow(row: string[]): string {
		return `│ ${row.map((v, c) => padCell(v, c)).join(" │ ")} │`;
	}

	// Top border.
	const topBorder = `┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
	// Header separator.
	const headerSep = `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
	// Bottom border.
	const bottomBorder = `└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;

	const lines: string[] = [];
	lines.push(` ${theme.fg("dim", topBorder)}`);
	lines.push(
		` ${theme.fg("dim", "│")} ${table.columns.map((v, c) => theme.bold(padCell(v, c))).join(` ${theme.fg("dim", "│")} `)} ${theme.fg("dim", "│")}`,
	);
	lines.push(` ${theme.fg("dim", headerSep)}`);
	for (const row of table.rows) {
		lines.push(` ${theme.fg("dim", formatRow(row))}`);
	}
	lines.push(` ${theme.fg("dim", bottomBorder)}`);

	return lines;
}

/** Format byte count as a human-readable size. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A message in a thread for the send_thread confirmation gate. */
export interface ThreadMessage {
	text: string;
	files?: FileInfo[];
	table?: TableParam;
}

/**
 * Confirm sending a thread of messages.
 *
 * Shows a tabbed panel with one tab per message. Each tab
 * renders the message text as markdown plus any file
 * attachment info. The user approves each message via Enter
 * or rejects via 'r'. Any rejection halts the entire thread
 * and returns a redirect.
 */
export async function confirmSendThread(
	ctx: ExtensionContext,
	conversationName: string,
	messages: ThreadMessage[],
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };

	const context = `Send thread (${messages.length} messages) to ${conversationName}`;

	const result = await promptTabbed(ctx, {
		title: ` Send Thread to ${conversationName}`,
		items: messages.map((msg, i) => ({
			label: `M${i + 1}`,
			views: [
				{
					key: "1",
					label: "Message",
					content: (theme, width) => {
						const lines: string[] = [];
						const role = i === 0 ? "Thread parent" : `Reply ${i}`;
						lines.push(` ${theme.fg("muted", role)}`);
						lines.push("");
						for (const line of renderMarkdown(msg.text, theme, width)) {
							lines.push(line);
						}
						if (msg.table) {
							lines.push("");
							for (const line of renderTablePreview(msg.table, theme, width)) {
								lines.push(line);
							}
						}
						if (msg.files?.length) {
							lines.push("");
							for (const f of msg.files) {
								lines.push(
									` 📄 ${f.name} ${theme.fg("dim", `(${formatBytes(f.size)})`)}`,
								);
							}
						}
						return lines;
					},
				},
			],
		})),
		actions: REJECT_ACTION,
		autoResolve: true,
	});

	if (!result) return null;

	// Ctrl+Enter can submit before all tabs are reviewed.
	// Treat incomplete review as a cancellation so no
	// unreviewed messages slip through.
	if (result.items.size < messages.length) {
		return redirect(
			"Not all messages were reviewed. Review every message before sending.",
			context,
		);
	}

	// Check each tab's result. Any rejection or redirect halts everything.
	for (const [, itemResult] of result.items) {
		if (itemResult.type === "redirect") {
			return redirect(itemResult.note, context);
		}
		if (itemResult.type === "action" && itemResult.key === "r") {
			const note = itemResult.note ?? "User rejected. Ask for guidance.";
			return redirect(note, context);
		}
		// Action with a note (annotated Enter) is a redirect.
		if (itemResult.type === "action" && itemResult.note) {
			return redirect(itemResult.note, context);
		}
	}

	return { approved: true, data: true };
}

/**
 * Confirm adding or removing a reaction.
 */
export async function confirmReaction(
	ctx: ExtensionContext,
	conversationName: string,
	ts: string,
	emoji: string,
	action: "add" | "remove",
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };

	const verb = action === "add" ? "Add" : "Remove";
	const context = `${verb} :${emoji}: reaction in ${conversationName}`;

	const result = await promptSingle(ctx, {
		content: (theme) => [
			theme.fg("accent", theme.bold(` ${verb} Reaction`)),
			"",
			` ${theme.fg("muted", "In:")} ${conversationName}`,
			` ${theme.fg("muted", "Message:")} ${ts}`,
			` ${theme.fg("muted", "Emoji:")} :${emoji}:`,
		],
		actions: REJECT_ACTION,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return redirect(result.note, context);
	}

	if (result.type === "action") {
		if (result.key === "r") {
			if (result.note) return redirect(result.note, context);
			return redirect("User rejected. Ask for guidance.", context);
		}
		// Enter (approve)
		if (result.note) return redirect(result.note, context);
		return { approved: true, data: true };
	}

	return { approved: true, data: true };
}
