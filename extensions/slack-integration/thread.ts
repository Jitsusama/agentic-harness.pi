/**
 * Sending several messages under one gate: a new thread through
 * `send_thread`, or queued replies to an existing one through
 * `reply_to_thread`'s `messages`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	replyToThread,
	type SlackClient,
	sendMessage,
	uploadFiles,
} from "../../lib/slack/index.ts";
import type {
	ActionParams,
	ResolvedParams,
	ToolResult,
} from "../../lib/slack/types.ts";
import { count, verb } from "../../lib/ui/count.ts";
import { OUTCOME_GLYPH } from "../../lib/ui/outcome-glyphs.ts";
import { messageBlocks, tableOf, validateTable } from "./blocks.ts";
import {
	confirmSendThread,
	type TableParam,
	type ThreadMessage,
} from "./confirmation.ts";
import { missing, nameOf, text } from "./results.ts";
import { fileInfosOf } from "./uploads.ts";

/** Parsed thread message with collected file paths and optional table. */
export interface ParsedThreadMessage {
	text: string;
	filePaths: string[];
	table?: TableParam;
}

/** The `send_thread` action: a parent message and its replies. */
export async function handleSendThread(
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

	const parsed = parseThreadMessages(rawMessages);
	if (typeof parsed === "string") return text(parsed);

	return dispatchThread(
		client,
		ctx,
		resolved.conversation.id,
		nameOf(resolved.conversation),
		parsed,
		undefined,
	);
}

/**
 * Validate, confirm and send a sequence of thread messages.
 *
 * When `existingParentTs` is undefined, the first message
 * creates a new thread parent and the remaining messages
 * become replies (the `send_thread` flow).
 *
 * When `existingParentTs` is provided, every message is
 * sent as a reply to that existing thread (the queued-reply
 * flow on `reply_to_thread`).
 */
export async function dispatchThread(
	client: SlackClient,
	ctx: ExtensionContext,
	channelId: string,
	displayName: string,
	parsed: ParsedThreadMessage[],
	existingParentTs: string | undefined,
): Promise<ToolResult> {
	// Validate tables and gather file info for the gate.
	const threadMessages: ThreadMessage[] = [];
	for (const [idx, msg] of parsed.entries()) {
		const fileInfos = await fileInfosOf(msg.filePaths);
		if (typeof fileInfos === "string") return text(fileInfos);
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

	const isReplyMode = existingParentTs !== undefined;
	const cancelLabel = isReplyMode
		? `${OUTCOME_GLYPH.cancelled} Queued replies cancelled.`
		: `${OUTCOME_GLYPH.cancelled} Send thread cancelled.`;
	const noun = isReplyMode ? "replies" : "thread";

	const confirmed = await confirmSendThread(
		ctx,
		displayName,
		threadMessages,
		existingParentTs,
	);
	if (!confirmed) return text(cancelLabel);
	if (!confirmed.approved) return text(confirmed.redirect);

	// Send messages sequentially. In create mode the first
	// becomes the parent; in reply mode every message is a
	// reply to `existingParentTs`. Messages with files use
	// the upload flow with initialComment so text and files
	// appear as a single Slack message.
	let parentTs = existingParentTs;
	let sent = 0;

	for (const [i, msg] of parsed.entries()) {
		const isParent = !isReplyMode && i === 0;

		try {
			const msgBlocks = await messageBlocks(client, msg.text, msg.table);

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
						`${OUTCOME_GLYPH.failed} ${noun} failed: missing parent thread timestamp. ` +
							`Sent ${sent} of ${parsed.length} messages.`,
					);
				}
				await replyToThread(client, channelId, parentTs, msg.text, msgBlocks);
			}
			sent++;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return text(
				`${OUTCOME_GLYPH.failed} ${noun} failed at message ${i + 1} of ${parsed.length}: ${reason}. ` +
					`${count(sent, "message")} ${verb(sent, "was", "were")} already sent.`,
			);
		}
	}

	if (isReplyMode) {
		return text(
			`\u2713 ${parsed.length} replies sent in ${displayName} thread ${parentTs}`,
			{ threadTs: parentTs },
		);
	}
	return text(
		`\u2713 Thread sent to ${displayName} (${parsed.length} messages, parent ts: ${parentTs})`,
		{ threadTs: parentTs },
	);
}

/**
 * Parse and validate the raw messages array from tool params.
 *
 * Returns the parsed messages or an error string.
 */
export function parseThreadMessages(
	raw: unknown[],
): ParsedThreadMessage[] | string {
	const messages: ParsedThreadMessage[] = [];

	for (const [i, value] of raw.entries()) {
		const entry = value as Record<string, unknown> | undefined;
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

		messages.push({
			text: msgText,
			filePaths: [...new Set(filePaths)],
			table: tableOf(entry.table),
		});
	}

	return messages;
}
