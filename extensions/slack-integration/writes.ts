/**
 * The actions that write one thing to Slack in the person's name: a
 * message, a reply, an edit or a reaction, each behind its
 * confirmation gate.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	addReaction,
	editMessage,
	removeReaction,
	replyToThread,
	type SlackClient,
	sendMessage,
} from "../../lib/slack/index.ts";
import {
	type ActionParams,
	type ResolvedParams,
	stringParam,
	type ToolResult,
} from "../../lib/slack/types.ts";
import { OUTCOME_GLYPH } from "../../lib/ui/outcome-glyphs.ts";
import { messageBlocks, tableOf, validateTable } from "./blocks.ts";
import {
	confirmEditMessage,
	confirmReaction,
	confirmReply,
	confirmSendMessage,
	type TableParam,
} from "./confirmation.ts";
import { type ActionHandler, missing, nameOf, text } from "./results.ts";
import { dispatchThread, parseThreadMessages } from "./thread.ts";
import { collectFilePaths, handleFileUpload } from "./uploads.ts";

/** A message ready for its gate, or what to answer instead. */
type Composed =
	| { blocks: unknown[] | undefined; shown: string }
	| { refusal: ToolResult };

/**
 * The blocks a message's text and table go as, and the text its gate
 * shows and Slack notifies with: a table sent alone is named by its
 * rows.
 */
async function compose(
	client: SlackClient,
	msgText: string | undefined,
	table: TableParam | undefined,
): Promise<Composed> {
	if (table) {
		const error = validateTable(table);
		if (error) return { refusal: text(error) };
	}
	const blocks = await messageBlocks(client, msgText, table);
	const shown =
		msgText ?? (table ? `Table with ${table.rows.length} rows` : "");
	if (!shown) return { refusal: missing("text") };
	return { blocks, shown };
}

/** The `send_message` action: a new message in a conversation. */
export async function handleSendMessage(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");
	const msgText = stringParam(params, "text");
	const filePaths = collectFilePaths(params);
	const tableParam = tableOf(params.table);
	if (!msgText && filePaths.length === 0 && !tableParam) return missing("text");

	const displayName = nameOf(resolved.conversation);

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

	const message = await compose(client, msgText, tableParam);
	if ("refusal" in message) return message.refusal;

	const confirmed = await confirmSendMessage(
		ctx,
		displayName,
		message.shown,
		tableParam,
	);
	if (!confirmed)
		return text(`${OUTCOME_GLYPH.cancelled} Send message cancelled.`);
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await sendMessage(
		client,
		resolved.conversation.id,
		confirmed.data.text,
		message.blocks,
	);
	return text(`✓ Message sent to ${displayName} (ts: ${result.ts})`, result);
}

/** The `reply_to_thread` action: one reply, or several queued. */
export async function handleReplyToThread(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const msgText = stringParam(params, "text");
	const filePaths = collectFilePaths(params);
	const tableParam = tableOf(params.table);
	const rawMessages = params.messages;
	const hasMessages = Array.isArray(rawMessages) && rawMessages.length > 0;

	const displayName = nameOf(resolved.target.conversation);

	// Multi-reply mode: queue several replies in a single
	// gate, mirroring send_thread but rooted on the existing
	// parent. Mutually exclusive with the single-reply
	// params (text/files/table) so the user's intent is
	// unambiguous.
	if (hasMessages) {
		if (msgText || filePaths.length > 0 || tableParam) {
			return text(
				`${OUTCOME_GLYPH.failed} Cannot combine \`messages\` with \`text\`, file or table params. ` +
					"Use `messages` for queued replies, or the single-reply params for one reply.",
			);
		}
		const parsed = parseThreadMessages(rawMessages);
		if (typeof parsed === "string") return text(parsed);
		return dispatchThread(
			client,
			ctx,
			resolved.target.conversation.id,
			displayName,
			parsed,
			resolved.target.ts,
		);
	}

	if (!msgText && filePaths.length === 0 && !tableParam) return missing("text");

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

	const message = await compose(client, msgText, tableParam);
	if ("refusal" in message) return message.refusal;

	const confirmed = await confirmReply(
		ctx,
		displayName,
		resolved.target.ts,
		message.shown,
		tableParam,
	);
	if (!confirmed) return text(`${OUTCOME_GLYPH.cancelled} Reply cancelled.`);
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await replyToThread(
		client,
		resolved.target.conversation.id,
		resolved.target.ts,
		confirmed.data.text,
		message.blocks,
	);
	return text(
		`✓ Reply sent in thread ${resolved.target.ts} (ts: ${result.ts})`,
		result,
	);
}

/** The `edit_message` action: new text or a new table for a message. */
export async function handleEditMessage(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const msgText = stringParam(params, "text");
	const tableParam = tableOf(params.table);
	if (!msgText && !tableParam) return missing("text");

	// chat.update can rewrite text and blocks but cannot
	// add or remove file attachments. Reject file params
	// up front so the agent isn't surprised when the files
	// silently disappear from its plan.
	if (collectFilePaths(params).length > 0) {
		return text(
			`${OUTCOME_GLYPH.failed} edit_message cannot change file attachments. ` +
				"Slack's chat.update API only updates text and blocks. " +
				"Delete the message and re-upload if attachments need to change.",
		);
	}

	const displayName = nameOf(resolved.target.conversation);

	// Blocks are built as a send builds them, so an edit keeps its
	// table and rich text.
	const message = await compose(client, msgText, tableParam);
	if ("refusal" in message) return message.refusal;

	const confirmed = await confirmEditMessage(
		ctx,
		displayName,
		resolved.target.ts,
		message.shown,
		tableParam,
	);
	if (!confirmed) return text(`${OUTCOME_GLYPH.cancelled} Edit cancelled.`);
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await editMessage(
		client,
		resolved.target.conversation.id,
		resolved.target.ts,
		confirmed.data.text,
		message.blocks,
	);
	return text(`✓ Message edited in ${displayName} (ts: ${result.ts})`, result);
}

/** What adding and removing a reaction each call, say and ask. */
const REACTIONS = {
	add: { change: addReaction, done: "Added", cancelled: "Reaction cancelled." },
	remove: {
		change: removeReaction,
		done: "Removed",
		cancelled: "Reaction removal cancelled.",
	},
} as const;

/** The `add_reaction` or `remove_reaction` action, by its direction. */
function reacting(direction: keyof typeof REACTIONS): ActionHandler {
	const { change, done, cancelled } = REACTIONS[direction];
	return async (client, params, resolved, ctx) => {
		if (!resolved.target) return missing("channel + ts or target");
		const emoji = stringParam(params, "emoji");
		if (!emoji) return missing("emoji");

		const confirmed = await confirmReaction(
			ctx,
			nameOf(resolved.target.conversation),
			resolved.target.ts,
			emoji,
			direction,
		);
		if (!confirmed) return text(`${OUTCOME_GLYPH.cancelled} ${cancelled}`);
		if (!confirmed.approved) return text(confirmed.redirect);

		await change(
			client,
			resolved.target.conversation.id,
			resolved.target.ts,
			emoji,
		);
		return text(`✓ ${done} :${emoji}: reaction`);
	};
}

/** The `add_reaction` action. */
export const handleAddReaction = reacting("add");

/** The `remove_reaction` action. */
export const handleRemoveReaction = reacting("remove");
