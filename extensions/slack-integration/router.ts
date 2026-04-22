/**
 * Routes incoming Slack tool actions to the appropriate
 * API handlers.
 *
 * Resolves all identifiers (channel, target, user) before
 * dispatching so handlers receive typed objects instead of
 * raw strings. Each action maps to a handler via a registry.
 */

import { basename } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getChannelInfo } from "../../lib/slack/api/channels.js";
import type { SlackClient } from "../../lib/slack/api/client.js";
import {
	type DownloadedFile,
	downloadFiles,
	getFileSize,
	uploadFiles,
} from "../../lib/slack/api/files.js";
import {
	formatMentions,
	getMessage,
	getThread,
	listMessages,
	replyToThread,
	sendMessage,
} from "../../lib/slack/api/messages.js";
import {
	addReaction,
	getReactions,
	listReactions,
	removeReaction,
} from "../../lib/slack/api/reactions.js";
import { resolveMessages } from "../../lib/slack/api/resolve-messages.js";
import { searchFiles, searchMessages } from "../../lib/slack/api/search.js";
import { getUserInfo } from "../../lib/slack/api/users.js";
import { parseMrkdwnToElements, tableToBlock } from "../../lib/slack/blocks.js";
import { renderChannel } from "../../lib/slack/renderers/channel.js";
import {
	renderMessage,
	renderMessageList,
	renderThread,
} from "../../lib/slack/renderers/message.js";
import {
	renderMessageReactions,
	renderReactedMessages,
} from "../../lib/slack/renderers/reactions.js";
import { renderFileList } from "../../lib/slack/renderers/search.js";
import { renderUser } from "../../lib/slack/renderers/user.js";
import { resolveConversation } from "../../lib/slack/resolvers/conversation.js";
import { resolveTarget } from "../../lib/slack/resolvers/target.js";
import { resolveUser } from "../../lib/slack/resolvers/user.js";
import {
	type ActionParams,
	numberParam,
	type ResolvedParams,
	type SlackColumnSetting,
	type SlackMessage,
	type SlackTable,
	stringParam,
	type ToolContent,
	type ToolResult,
} from "../../lib/slack/types.js";
import {
	confirmReaction,
	confirmReply,
	confirmSendMessage,
	confirmSendThread,
	confirmUploadFile,
	type FileInfo,
	type TableParam,
	type ThreadMessage,
} from "./confirmation.js";

/** Handler function that processes a Slack action. */
type ActionHandler = (
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
) => Promise<ToolResult>;

/**
 * Route a tool action to the appropriate handler.
 *
 * Resolves all identifiers upfront, then dispatches to the
 * handler with both raw params and resolved types.
 */
export async function routeAction(
	action: string,
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const handler = ACTION_HANDLERS.get(action);
	if (!handler) {
		return text(`Unknown action: ${action}`);
	}

	const resolved = await resolveAllParams(client, params);
	return handler(client, params, resolved, ctx);
}

/** Shorthand for a simple text result. */
function text(content: string, details?: unknown): ToolResult {
	return { content: [{ type: "text", text: content }], details };
}

/** Build a result with text and optional file content. */
function textWithFiles(
	content: string,
	files: DownloadedFile[],
	details?: unknown,
): ToolResult {
	const parts: ToolContent[] = [{ type: "text", text: content }];
	for (const file of files) {
		if (file.kind === "image") {
			parts.push({ type: "image", data: file.data, mimeType: file.mimeType });
		} else {
			parts.push({ type: "text", text: `\n📄 ${file.name}:\n${file.text}` });
		}
	}
	return { content: parts, details };
}

/**
 * Download displayable files from a set of messages.
 *
 * Collects all files across the messages and downloads
 * images and text-based files via the authenticated client.
 */
async function collectFileContent(
	client: SlackClient,
	messages: SlackMessage[],
	signal?: AbortSignal,
): Promise<DownloadedFile[]> {
	const allFiles = messages.flatMap((m) => m.files ?? []);
	if (allFiles.length === 0) return [];
	return downloadFiles(client, allFiles, signal);
}

/** Shorthand for missing parameter errors. */
function missing(param: string): ToolResult {
	return text(`Missing required parameter: ${param}`);
}

/**
 * Resolve all identifiers from raw tool parameters.
 *
 * Runs before every handler so they receive typed objects
 * instead of raw strings. Resolution errors (unknown channel,
 * bad URL) propagate as exceptions to the caller.
 */
async function resolveAllParams(
	client: SlackClient,
	params: ActionParams,
): Promise<ResolvedParams> {
	const resolved: ResolvedParams = {};

	const targetStr = stringParam(params, "target");
	const channelStr = stringParam(params, "channel");
	const tsStr = stringParam(params, "ts");
	const userStr = stringParam(params, "user");

	// Target (permalink or channel+ts) takes priority.
	if (targetStr || (channelStr && tsStr)) {
		try {
			resolved.target = await resolveTarget(
				client,
				targetStr,
				channelStr,
				tsStr,
			);
			resolved.conversation = resolved.target.conversation;
		} catch {
			// Target resolution failed. Fall through to channel-only
			// resolution if channel was provided without ts.
			if (channelStr && !tsStr) {
				resolved.conversation = await resolveConversation(client, channelStr);
			}
			// If target was explicitly provided and failed, re-throw.
			else if (targetStr) {
				throw new Error(
					"Could not parse the target URL. Provide a valid Slack permalink, " +
						"or use the channel and ts parameters instead.",
				);
			}
		}
	}
	// Channel without ts: conversation-only resolution.
	else if (channelStr) {
		resolved.conversation = await resolveConversation(client, channelStr);
	}

	// User resolution.
	if (userStr) {
		resolved.userId = await resolveUser(client, userStr);
	}

	return resolved;
}

/**
 * Coerce a timestamp parameter to Slack's epoch-seconds format.
 *
 * The agent often passes ISO date strings (e.g. "2026-01-27"
 * or "2026-01-27T00:00:00Z") for oldest/latest, but Slack's
 * conversations.history API expects Unix epoch seconds (e.g.
 * "1737936000"). This silently converts dates so the API
 * doesn't ignore them and return empty results.
 */
function coerceTimestamp(value: string | undefined): string | undefined {
	if (!value) return undefined;

	// Already a numeric timestamp (epoch seconds or Slack ts with decimals).
	if (/^\d+(\.\d+)?$/.test(value)) return value;

	// ISO date or datetime string: parse and convert to epoch seconds.
	const parsed = Date.parse(value);
	if (!Number.isNaN(parsed)) {
		return String(parsed / 1000);
	}

	// Unrecognised format: pass through and let Slack deal with it.
	return value;
}

/**
 * Fall back to `*` when no explicit query is given but
 * structured search params (from, with, channel, after,
 * before) are present. Lets agents omit `query` when
 * filtering by operator alone.
 */
function defaultQuery(params: ActionParams): string | undefined {
	const hasOperator =
		stringParam(params, "from") ||
		stringParam(params, "with") ||
		stringParam(params, "channel") ||
		stringParam(params, "after") ||
		stringParam(params, "before");
	return hasOperator ? "*" : undefined;
}

// ── Read handlers ───────────────────────────────────────

async function handleSearchMessages(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const query = stringParam(params, "query") ?? defaultQuery(params);
	if (!query) return missing("query");

	// Validate: search doesn't support DM conversations.
	if (resolved.conversation) {
		const conv = resolved.conversation;
		if (conv.kind === "dm" || conv.kind === "group_dm") {
			return text(
				`Slack search doesn't support ${conv.kind === "dm" ? "DM" : "group DM"} conversations. ` +
					"Use `list_messages` with the user ID as the channel instead.",
			);
		}
	}

	const result = await searchMessages(client, query, {
		// Use the resolved channel name for the search operator.
		channel: resolved.conversation?.name ?? stringParam(params, "channel"),
		from: stringParam(params, "from"),
		with: stringParam(params, "with"),
		after: stringParam(params, "after"),
		before: stringParam(params, "before"),
		limit: numberParam(params, "limit"),
	});

	// Resolve users, conversations and channel mentions so
	// the rendered output shows handles instead of raw IDs.
	await resolveMessages(client, result.messages);

	return text(renderMessageList(result.messages, result.total, result.query), {
		messages: result.messages,
		total: result.total,
		query: result.query,
	});
}

async function handleSearchFiles(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const query = stringParam(params, "query") ?? defaultQuery(params);
	if (!query) return missing("query");

	// Validate: search doesn't support DM conversations.
	if (resolved.conversation) {
		const conv = resolved.conversation;
		if (conv.kind === "dm" || conv.kind === "group_dm") {
			return text(
				`Slack search doesn't support ${conv.kind === "dm" ? "DM" : "group DM"} conversations. ` +
					"Use `list_messages` with the user ID as the channel instead.",
			);
		}
	}

	const result = await searchFiles(client, query, {
		channel: resolved.conversation?.name ?? stringParam(params, "channel"),
		from: stringParam(params, "from"),
		with: stringParam(params, "with"),
		after: stringParam(params, "after"),
		before: stringParam(params, "before"),
		type: stringParam(params, "type"),
		limit: numberParam(params, "limit"),
	});

	return text(renderFileList(result.files, result.total, result.query), {
		files: result.files,
		total: result.total,
		query: result.query,
	});
}

async function handleGetMessage(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const messageId = stringParam(params, "message_id");
	const msg = await getMessage(
		client,
		resolved.target.conversation,
		resolved.target.ts,
		messageId,
	);
	await resolveMessages(client, [msg]);
	const files = await collectFileContent(client, [msg]);
	return textWithFiles(renderMessage(msg), files, { message: msg });
}

async function handleGetThread(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const messages = await getThread(
		client,
		resolved.target.conversation,
		resolved.target.ts,
		numberParam(params, "limit"),
	);
	await resolveMessages(client, messages);
	const files = await collectFileContent(client, messages);
	return textWithFiles(renderThread(messages), files, { messages });
}

async function handleListMessages(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");

	const messages = await listMessages(client, resolved.conversation, {
		limit: numberParam(params, "limit"),
		oldest: coerceTimestamp(stringParam(params, "oldest")),
		latest: coerceTimestamp(stringParam(params, "latest")),
	});
	await resolveMessages(client, messages);
	const files = await collectFileContent(client, messages);
	return textWithFiles(renderMessageList(messages), files, { messages });
}

async function handleGetChannel(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");

	const info = await getChannelInfo(client, resolved.conversation.id);
	return text(renderChannel(info), { channel: info });
}

async function handleGetUser(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.userId) return missing("user");

	const info = await getUserInfo(client, resolved.userId);
	return text(renderUser(info), { user: info });
}

async function handleListReactions(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const messages = await listReactions(client, {
		user: resolved.userId ?? stringParam(params, "user"),
		limit: numberParam(params, "limit"),
	});
	return text(renderReactedMessages(messages), { messages });
}

async function handleGetReactions(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const data = await getReactions(
		client,
		resolved.target.conversation.id,
		resolved.target.ts,
	);
	return text(renderMessageReactions(data), { reactions: data });
}

// ── Table helpers ───────────────────────────────────────

/** Maximum rows in a Slack table block. */
const MAX_TABLE_ROWS = 100;

/** Maximum columns in a Slack table block. */
const MAX_TABLE_COLUMNS = 20;

/** Extract and validate a table from tool params. */
function extractTableParam(params: ActionParams): TableParam | undefined {
	const raw = params.table as
		| { columns?: string[]; rows?: string[][]; column_settings?: unknown[] }
		| undefined;
	if (!raw || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) {
		return undefined;
	}
	return {
		columns: raw.columns,
		rows: raw.rows,
		column_settings: Array.isArray(raw.column_settings)
			? raw.column_settings
			: undefined,
	};
}

/** Validate table dimensions and row consistency. */
function validateTable(table: TableParam): string | undefined {
	if (table.columns.length === 0) return "Table must have at least one column.";
	if (table.columns.length > MAX_TABLE_COLUMNS) {
		return `Table exceeds ${MAX_TABLE_COLUMNS} column limit (got ${table.columns.length}).`;
	}
	if (table.rows.length > MAX_TABLE_ROWS) {
		return `Table exceeds ${MAX_TABLE_ROWS} row limit (got ${table.rows.length}).`;
	}
	for (let i = 0; i < table.rows.length; i++) {
		if (table.rows[i].length !== table.columns.length) {
			return (
				`Row ${i + 1} has ${table.rows[i].length} cells ` +
				`but table has ${table.columns.length} columns.`
			);
		}
	}
	return undefined;
}

/**
 * Resolve @mentions and build a Block Kit table block.
 *
 * Runs formatMentions on every cell, maps column settings,
 * and returns the Block Kit block ready for chat.postMessage.
 */
async function buildTableBlock(
	client: SlackClient,
	rawTable: TableParam,
	signal?: AbortSignal,
): Promise<unknown> {
	// Resolve @mentions in all cells.
	const columns = await Promise.all(
		rawTable.columns.map((c) => formatMentions(client, c, signal)),
	);
	const rows = await Promise.all(
		rawTable.rows.map((row) =>
			Promise.all(row.map((cell) => formatMentions(client, cell, signal))),
		),
	);

	// Map column_settings from snake_case to camelCase.
	let columnSettings: (SlackColumnSetting | null)[] | undefined;
	if (rawTable.column_settings) {
		columnSettings = rawTable.column_settings.map((s) => {
			if (s == null) return null;
			const entry = s as { align?: string; is_wrapped?: boolean };
			const setting: SlackColumnSetting = {};
			if (
				entry.align === "left" ||
				entry.align === "center" ||
				entry.align === "right"
			) {
				setting.align = entry.align;
			}
			if (typeof entry.is_wrapped === "boolean") {
				setting.isWrapped = entry.is_wrapped;
			}
			return Object.keys(setting).length > 0 ? setting : null;
		});
	}

	const table: SlackTable = { columns, rows, columnSettings };
	return tableToBlock(table);
}

// ── Write handlers (with confirmation gates) ────────────

async function handleSendMessage(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");
	const msgText = stringParam(params, "text");
	const filePaths = collectFilePaths(params);
	const tableParam = extractTableParam(params);
	if (!msgText && filePaths.length === 0 && !tableParam) return missing("text");

	const displayName =
		resolved.conversation.displayName ?? resolved.conversation.id;

	// When files are attached, use the upload flow instead.
	if (filePaths.length > 0) {
		return handleFileUpload(
			client,
			ctx,
			displayName,
			filePaths,
			resolved.conversation.id,
			undefined,
			msgText,
		);
	}

	// Validate and build table block if present.
	let blocks: unknown[] | undefined;
	if (tableParam) {
		const error = validateTable(tableParam);
		if (error) return text(error);
		const tableBlock = await buildTableBlock(client, tableParam);
		// When blocks are present, Slack's text field is only a
		// notification fallback — it doesn't render in the message.
		// Prepend a rich_text block so the message text is visible.
		blocks = [];
		if (msgText) {
			const formatted = await formatMentions(client, msgText);
			blocks.push({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_section",
						elements: parseMrkdwnToElements(formatted),
					},
				],
			});
		}
		blocks.push(tableBlock);
	}

	// Generate fallback text for notifications when only a table is present.
	const effectiveText =
		msgText ?? (tableParam ? `Table with ${tableParam.rows.length} rows` : "");
	if (!effectiveText) return missing("text");

	const confirmed = await confirmSendMessage(
		ctx,
		displayName,
		effectiveText,
		tableParam,
	);
	if (!confirmed) return text("✗ Send message cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await sendMessage(
		client,
		resolved.conversation.id,
		confirmed.data.text,
		blocks,
	);
	return text(`✓ Message sent to ${displayName} (ts: ${result.ts})`, result);
}

async function handleReplyToThread(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const msgText = stringParam(params, "text");
	const filePaths = collectFilePaths(params);
	const tableParam = extractTableParam(params);
	if (!msgText && filePaths.length === 0 && !tableParam) return missing("text");

	const displayName =
		resolved.target.conversation.displayName ?? resolved.target.conversation.id;

	// When files are attached, use the upload flow instead.
	if (filePaths.length > 0) {
		return handleFileUpload(
			client,
			ctx,
			displayName,
			filePaths,
			resolved.target.conversation.id,
			resolved.target.ts,
			msgText,
		);
	}

	// Validate and build table block if present.
	let blocks: unknown[] | undefined;
	if (tableParam) {
		const error = validateTable(tableParam);
		if (error) return text(error);
		const tableBlock = await buildTableBlock(client, tableParam);
		blocks = [];
		if (msgText) {
			const formatted = await formatMentions(client, msgText);
			blocks.push({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_section",
						elements: parseMrkdwnToElements(formatted),
					},
				],
			});
		}
		blocks.push(tableBlock);
	}

	const effectiveText =
		msgText ?? (tableParam ? `Table with ${tableParam.rows.length} rows` : "");
	if (!effectiveText) return missing("text");

	const confirmed = await confirmReply(
		ctx,
		displayName,
		resolved.target.ts,
		effectiveText,
		tableParam,
	);
	if (!confirmed) return text("✗ Reply cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await replyToThread(
		client,
		resolved.target.conversation.id,
		resolved.target.ts,
		confirmed.data.text,
		blocks,
	);
	return text(
		`✓ Reply sent in thread ${resolved.target.ts} (ts: ${result.ts})`,
		result,
	);
}

async function handleAddReaction(
	_client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const emoji = stringParam(params, "emoji");
	if (!emoji) return missing("emoji");

	const displayName =
		resolved.target.conversation.displayName ?? resolved.target.conversation.id;
	const confirmed = await confirmReaction(
		ctx,
		displayName,
		resolved.target.ts,
		emoji,
		"add",
	);
	if (!confirmed) return text("✗ Reaction cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	await addReaction(
		_client,
		resolved.target.conversation.id,
		resolved.target.ts,
		emoji,
	);
	return text(`✓ Added :${emoji}: reaction`);
}

async function handleRemoveReaction(
	_client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const emoji = stringParam(params, "emoji");
	if (!emoji) return missing("emoji");

	const displayName =
		resolved.target.conversation.displayName ?? resolved.target.conversation.id;
	const confirmed = await confirmReaction(
		ctx,
		displayName,
		resolved.target.ts,
		emoji,
		"remove",
	);
	if (!confirmed) return text("✗ Reaction removal cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	await removeReaction(
		_client,
		resolved.target.conversation.id,
		resolved.target.ts,
		emoji,
	);
	return text(`✓ Removed :${emoji}: reaction`);
}

async function handleUploadFile(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");
	const filePaths = collectFilePaths(params);
	if (filePaths.length === 0) return missing("file_path or file_paths");

	const displayName =
		resolved.conversation.displayName ?? resolved.conversation.id;
	const threadTs = resolved.target?.ts;
	const msgText = stringParam(params, "text");

	return handleFileUpload(
		client,
		ctx,
		displayName,
		filePaths,
		resolved.conversation.id,
		threadTs,
		msgText,
	);
}

async function handleSendThread(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");

	const rawMessages = params.messages;
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
		return missing("messages");
	}

	// Parse and validate the messages array.
	const parsed = parseThreadMessages(rawMessages);
	if (typeof parsed === "string") return text(parsed);

	const displayName =
		resolved.conversation.displayName ?? resolved.conversation.id;

	// Validate tables and gather file info.
	const threadMessages: ThreadMessage[] = [];
	for (let idx = 0; idx < parsed.length; idx++) {
		const msg = parsed[idx];
		const fileInfos: FileInfo[] = [];
		for (const filePath of msg.filePaths) {
			try {
				const size = await getFileSize(filePath);
				fileInfos.push({ name: basename(filePath), size });
			} catch {
				return text(`File not found: ${filePath}`);
			}
		}
		if (msg.table) {
			const error = validateTable(msg.table);
			if (error) return text(`Message ${idx + 1}: ${error}`);
		}
		threadMessages.push({
			text: msg.text,
			files: fileInfos.length > 0 ? fileInfos : undefined,
			table: msg.table,
		});
	}

	// Show the tabbed confirmation gate.
	const confirmed = await confirmSendThread(ctx, displayName, threadMessages);
	if (!confirmed) return text("\u2717 Send thread cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	// Send messages sequentially: first creates the parent,
	// the rest reply to it. Messages with files use the
	// upload flow with initialComment so text and files
	// appear as a single message.
	const channelId = resolved.conversation.id;
	let parentTs: string | undefined;
	let sent = 0;

	for (let i = 0; i < parsed.length; i++) {
		const msg = parsed[i];
		const isParent = i === 0;

		try {
			// Build table block if this message has a table.
			let msgBlocks: unknown[] | undefined;
			if (msg.table) {
				const tableBlock = await buildTableBlock(client, msg.table);
				msgBlocks = [];
				if (msg.text) {
					const formatted = await formatMentions(client, msg.text);
					msgBlocks.push({
						type: "rich_text",
						elements: [
							{
								type: "rich_text_section",
								elements: parseMrkdwnToElements(formatted),
							},
						],
					});
				}
				msgBlocks.push(tableBlock);
			}

			if (msg.filePaths.length > 0) {
				const uploadResult = await uploadFiles(client, msg.filePaths, {
					channelId,
					threadTs: parentTs,
					initialComment: msg.text,
				});
				if (isParent) {
					parentTs = uploadResult.ts;
				}
			} else if (isParent) {
				const result = await sendMessage(
					client,
					channelId,
					msg.text,
					msgBlocks,
				);
				parentTs = result.ts;
			} else {
				if (!parentTs) {
					return text(
						`\u2717 Thread failed: could not determine parent message timestamp. ` +
							`Sent ${sent} of ${parsed.length} messages.`,
					);
				}
				await replyToThread(client, channelId, parentTs, msg.text, msgBlocks);
			}
			sent++;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return text(
				`\u2717 Thread failed at message ${i + 1} of ${parsed.length}: ${reason}. ` +
					`${sent} message(s) were already sent.`,
			);
		}
	}

	return text(
		`\u2713 Thread sent to ${displayName} (${parsed.length} messages, parent ts: ${parentTs})`,
		{ threadTs: parentTs },
	);
}

/** Parsed thread message with collected file paths and optional table. */
interface ParsedThreadMessage {
	text: string;
	filePaths: string[];
	table?: TableParam;
}

/**
 * Parse and validate the raw messages array from tool params.
 *
 * Returns the parsed messages or an error string.
 */
function parseThreadMessages(raw: unknown[]): ParsedThreadMessage[] | string {
	const messages: ParsedThreadMessage[] = [];

	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i] as Record<string, unknown> | undefined;
		if (!entry || typeof entry !== "object") {
			return `Invalid message at index ${i}: expected an object.`;
		}

		const msgText = typeof entry.text === "string" ? entry.text : undefined;
		if (!msgText) {
			return `Missing text in message at index ${i}.`;
		}

		const filePaths: string[] = [];
		if (typeof entry.file_path === "string") {
			filePaths.push(entry.file_path);
		}
		if (Array.isArray(entry.file_paths)) {
			for (const p of entry.file_paths) {
				if (typeof p === "string") filePaths.push(p);
			}
		}

		// Optional table parameter.
		const tableRaw = entry.table as
			| { columns?: unknown; rows?: unknown; column_settings?: unknown }
			| undefined;
		let table: TableParam | undefined;
		if (
			tableRaw &&
			Array.isArray(tableRaw.columns) &&
			Array.isArray(tableRaw.rows)
		) {
			table = {
				columns: tableRaw.columns as string[],
				rows: tableRaw.rows as string[][],
				column_settings: Array.isArray(tableRaw.column_settings)
					? (tableRaw.column_settings as unknown[])
					: undefined,
			};
		}

		messages.push({
			text: msgText,
			filePaths: [...new Set(filePaths)],
			table,
		});
	}

	return messages;
}

// ── File upload helpers ─────────────────────────────────

/**
 * Collect file paths from the file_path and file_paths params.
 *
 * Accepts either a single path or an array, or both. Returns
 * a deduplicated list.
 */
function collectFilePaths(params: ActionParams): string[] {
	const paths: string[] = [];

	const single = stringParam(params, "file_path");
	if (single) paths.push(single);

	const multiple = params.file_paths;
	if (Array.isArray(multiple)) {
		for (const p of multiple) {
			if (typeof p === "string") paths.push(p);
		}
	}

	return [...new Set(paths)];
}

/**
 * Shared file upload flow used by upload_file, send_message
 * and reply_to_thread when files are present.
 *
 * Validates files exist, shows the confirmation gate, then
 * uploads via the 3-step Slack external upload API.
 */
async function handleFileUpload(
	client: SlackClient,
	ctx: ExtensionContext,
	displayName: string,
	filePaths: string[],
	channelId: string,
	threadTs?: string,
	initialComment?: string,
): Promise<ToolResult> {
	// Gather file info for the confirmation gate.
	const fileInfos: FileInfo[] = [];
	for (const filePath of filePaths) {
		try {
			const size = await getFileSize(filePath);
			fileInfos.push({ name: basename(filePath), size });
		} catch {
			return text(`File not found: ${filePath}`);
		}
	}

	const confirmed = await confirmUploadFile(
		ctx,
		displayName,
		fileInfos,
		initialComment,
		threadTs,
	);
	if (!confirmed) return text("✗ Upload cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await uploadFiles(client, filePaths, {
		channelId,
		threadTs,
		initialComment,
	});

	const fileNames = fileInfos.map((f) => f.name).join(", ");
	const threadNote = threadTs ? ` in thread ${threadTs}` : "";
	return text(`✓ Uploaded ${fileNames} to ${displayName}${threadNote}`, {
		upload: result,
	});
}

// ── Action registry ─────────────────────────────────────

const ACTION_HANDLERS = new Map<string, ActionHandler>([
	["search_messages", handleSearchMessages],
	["search_files", handleSearchFiles],
	["get_message", handleGetMessage],
	["get_thread", handleGetThread],
	["list_messages", handleListMessages],
	["get_channel", handleGetChannel],
	["get_user", handleGetUser],
	["list_reactions", handleListReactions],
	["get_reactions", handleGetReactions],
	["send_message", handleSendMessage],
	["reply_to_thread", handleReplyToThread],
	["upload_file", handleUploadFile],
	["send_thread", handleSendThread],
	["add_reaction", handleAddReaction],
	["remove_reaction", handleRemoveReaction],
]);
