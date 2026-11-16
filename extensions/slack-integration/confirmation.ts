/**
 * Confirmation gates for Slack write operations.
 *
 * Each gate shows the user what will happen and lets them
 * approve, reject, annotate or redirect, matching the
 * guardian pattern used elsewhere in the harness.
 *
 * Every gate belongs to the `slack` guard, which blocks by
 * default: a message reaches other people the moment it lands.
 * Switched to report, a gate approves and puts what it would
 * have asked about in the transcript.
 */

import type {
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	approvalUnder,
	fenced,
	unattendedRefusal,
} from "../../lib/guardian/apply.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import { renderMarkdown } from "../../lib/ui/content-renderer.ts";
import { frameTitle } from "../../lib/ui/frame.ts";
import { promptSingle, promptTabbed } from "../../lib/ui/panel.ts";
import { formatRedirectReason } from "../../lib/ui/redirect.ts";
import type { KeyAction, PromptResult } from "../../lib/ui/types.ts";

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

/**
 * The gate's answer when it needs no panel, or undefined when it should
 * ask. The slack guard decides: approved without asking (reported when
 * the guard reports), held while the person is away, or asked, which
 * with no screen to ask on is refused (`unattendedRefusal`).
 */
export function unasked<T>(
	ctx: ExtensionContext,
	data: T,
	title: string,
	text?: string,
): ConfirmResult<T> | undefined {
	const approval = approvalUnder(
		GUARDS.slack.name,
		title,
		text ? () => fenced(text) : undefined,
	);
	if (approval.kind === "go") return { approved: true, data };
	if (approval.kind === "held")
		return { approved: false, redirect: approval.reason };
	if (!ctx.hasUI) {
		return { approved: false, redirect: unattendedRefusal(`Slack: ${title}`) };
	}
	return undefined;
}

/** Shorthand for a redirect result. */
function redirect(note: string, context: string): ConfirmResult<never> {
	return { approved: false, redirect: formatRedirectReason(note, context) };
}

/** What a rejection says when the person gave no note. */
const REJECTED = "User rejected. Ask for guidance.";

/**
 * A single gate's answer, as every gate reads it: cancelled is null;
 * a redirect, a rejection or a note on Enter sends the agent back
 * with `context`; a plain Enter approves with `data`.
 */
export function answered<T>(
	result: PromptResult | null,
	context: string,
	data: T,
): ConfirmResult<T> {
	if (!result) return null;
	if (result.type === "redirect") return redirect(result.note, context);
	if (result.type === "action" && result.key === "r")
		return redirect(result.note || REJECTED, context);
	if (result.note) return redirect(result.note, context);
	return { approved: true, data };
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
	const skip = unasked(
		ctx,
		{ text },
		`Send message to ${conversationName}`,
		text,
	);
	if (skip) return skip;

	const context = `Send message to ${conversationName}:\n${text.slice(0, 200)}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				` ${frameTitle(theme, "Send Slack Message")}`,
				"",
				` ${theme.fg("muted", "To:")} ${conversationName}`,
				"",
			];
			lines.push(...messageLines(text, table, theme, width));
			return lines;
		},
		actions: REJECT_ACTION,
	});

	return answered(result, context, { text });
}

/**
 * Confirm editing an existing message.
 *
 * Mirrors the send-message gate: shows the new content the
 * message will be replaced with, plus the conversation and
 * timestamp so the user knows exactly which message gets
 * rewritten.
 */
export async function confirmEditMessage(
	ctx: ExtensionContext,
	conversationName: string,
	ts: string,
	text: string,
	table?: TableParam,
): Promise<ConfirmResult<{ text: string }>> {
	const skip = unasked(
		ctx,
		{ text },
		`Edit message ${ts} in ${conversationName}`,
		text,
	);
	if (skip) return skip;

	const context = `Edit message ${ts} in ${conversationName}:\n${text.slice(0, 200)}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				` ${frameTitle(theme, "Edit Slack Message")}`,
				"",
				` ${theme.fg("muted", "In:")} ${conversationName}`,
				` ${theme.fg("muted", "Message:")} ${ts}`,
				"",
			];
			lines.push(...messageLines(text, table, theme, width));
			return lines;
		},
		actions: REJECT_ACTION,
	});

	return answered(result, context, { text });
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
	const skip = unasked(
		ctx,
		{ text },
		`Reply in ${conversationName} thread ${threadTs}`,
		text,
	);
	if (skip) return skip;

	const context = `Reply in ${conversationName} thread ${threadTs}:\n${text.slice(0, 200)}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				` ${frameTitle(theme, "Reply to Thread")}`,
				"",
				` ${theme.fg("muted", "In:")} ${conversationName}`,
				` ${theme.fg("muted", "Thread:")} ${threadTs}`,
				"",
			];
			lines.push(...messageLines(text, table, theme, width));
			return lines;
		},
		actions: REJECT_ACTION,
	});

	return answered(result, context, { text });
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
	const [only] = files;
	const context = `Upload ${files.length === 1 && only ? only.name : `${files.length} files`} to ${conversationName}`;
	const skip = unasked(ctx, true as const, context, text);
	if (skip) return skip;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				` ${frameTitle(theme, "Upload File")}`,
				"",
				` ${theme.fg("muted", "To:")} ${conversationName}`,
			];
			if (threadTs) {
				lines.push(` ${theme.fg("muted", "Thread:")} ${threadTs}`);
			}
			lines.push("");
			lines.push(...fileLines(files, theme));
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

	return answered(result, context, true);
}

// ── Table preview rendering ─────────────────────────────

/**
 * Theme type from the promptSingle/promptTabbed content callback.
 *
 * `fg` takes pi's own colour union rather than a string: the colour
 * names are a closed set, and typing them as strings meant a real
 * theme could not be passed to a function declared to accept one.
 */
interface GateTheme {
	fg: (color: ThemeColor, text: string) => string;
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
		for (const [c, width] of widths.entries()) {
			widths[c] = Math.max(3, Math.floor(width * scale));
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
		// Every column was measured above, so the 0 is never reached.
		const w = widths[col] ?? 0;
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

/** A message's text as markdown, with its table below when it has one. */
function messageLines(
	text: string,
	table: TableParam | undefined,
	theme: Parameters<typeof renderMarkdown>[1],
	width: number,
): string[] {
	const lines = renderMarkdown(text, theme, width);
	if (!table) return lines;
	return [...lines, "", ...renderTablePreview(table, theme, width)];
}

/** One line for each file, with its size. */
function fileLines(files: FileInfo[], theme: GateTheme): string[] {
	return files.map(
		(f) => ` 📄 ${f.name} ${theme.fg("dim", `(${formatBytes(f.size)})`)}`,
	);
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
 *
 * When `parentTs` is provided, every message is framed as a
 * reply to that existing thread. When omitted, the first
 * message is the thread parent and the rest are replies.
 */
export async function confirmSendThread(
	ctx: ExtensionContext,
	conversationName: string,
	messages: ThreadMessage[],
	parentTs?: string,
): Promise<ConfirmResult<true>> {
	const skip = unasked(
		ctx,
		true as const,
		`Send a thread of ${messages.length} to ${conversationName}`,
		messages.map((m) => m.text).join("\n\n"),
	);
	if (skip) return skip;

	const isReplyMode = parentTs !== undefined;
	const action = isReplyMode
		? `Queue ${messages.length} replies in ${conversationName} thread ${parentTs}`
		: `Send thread (${messages.length} messages) to ${conversationName}`;
	// No leading space: the panel indents the title itself.
	const title = isReplyMode
		? `Queue ${messages.length} Replies in ${conversationName}`
		: `Send Thread to ${conversationName}`;
	const context = action;

	const result = await promptTabbed(ctx, {
		title,
		items: messages.map((msg, i) => ({
			label: `M${i + 1}`,
			views: [
				{
					key: "1",
					label: "Message",
					content: (theme, width) => {
						const lines: string[] = [];
						const role = isReplyMode
							? `Reply ${i + 1} of ${messages.length} (in thread ${parentTs})`
							: i === 0
								? "Thread parent"
								: `Reply ${i}`;
						lines.push(` ${theme.fg("muted", role)}`);
						lines.push("");
						lines.push(...messageLines(msg.text, msg.table, theme, width));
						if (msg.files?.length) {
							lines.push("");
							lines.push(...fileLines(msg.files, theme));
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

	// Ctrl+Enter or Ctrl+S can submit before all tabs are reviewed.
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
			const note = itemResult.note || REJECTED;
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
 * Confirm a Slack write through the tool gateway that no gate of the
 * gateway's own asks about: `tool` with `args`, as the gateway takes
 * them (`gateway-writes.ts`).
 */
export async function confirmGatewayWrite(
	ctx: ExtensionContext,
	tool: string,
	args: Record<string, unknown>,
): Promise<ConfirmResult<true>> {
	const context = `Run ${tool} on Slack through the tool gateway`;
	const skip = unasked(ctx, true as const, context, JSON.stringify(args));
	if (skip) return skip;

	const result = await promptSingle(ctx, {
		content: (theme) => [
			` ${frameTitle(theme, `Run ${tool}`)}`,
			"",
			` ${theme.fg("muted", "Through:")} the tool gateway, in your name`,
			...Object.entries(args).map(
				([key, value]) =>
					` ${theme.fg("muted", `${key}:`)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
			),
		],
		actions: REJECT_ACTION,
	});

	return answered(result, context, true);
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
	const verb = action === "add" ? "Add" : "Remove";
	const context = `${verb} :${emoji}: reaction in ${conversationName}`;
	const skip = unasked(ctx, true as const, context);
	if (skip) return skip;

	const result = await promptSingle(ctx, {
		content: (theme) => [
			` ${frameTitle(theme, `${verb} Reaction`)}`,
			"",
			` ${theme.fg("muted", "In:")} ${conversationName}`,
			` ${theme.fg("muted", "Message:")} ${ts}`,
			` ${theme.fg("muted", "Emoji:")} :${emoji}:`,
		],
		actions: REJECT_ACTION,
	});

	return answered(result, context, true);
}
