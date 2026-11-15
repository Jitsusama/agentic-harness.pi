/**
 * The actions that read Slack: searches, messages, threads,
 * conversations, people and reactions. None asks the person first,
 * since nothing leaves in their name.
 */

import {
	type DownloadedFile,
	downloadFiles,
	getChannelInfo,
	getMessage,
	getReactions,
	getThread,
	getUserInfo,
	listMessages,
	listReactions,
	renderChannel,
	renderFileList,
	renderMessage,
	renderMessageList,
	renderMessageReactions,
	renderReactedMessages,
	renderThread,
	renderUser,
	resolveMessages,
	type SlackClient,
	searchFiles,
	searchMessages,
} from "../../lib/slack/index.ts";
import {
	type ActionParams,
	numberParam,
	type ResolvedParams,
	type SlackMessage,
	stringParam,
	type ToolContent,
	type ToolResult,
} from "../../lib/slack/types.ts";
import { missing, text } from "./results.ts";

/**
 * Build a result with text and optional file content.
 *
 * The router bounds only the leading rendered text with the caller's
 * session context. Attached blocks stay unchanged: a file is what
 * the caller asked for by name, and half of one is no use.
 */
function textWithFiles(
	content: string,
	files: DownloadedFile[],
	details?: unknown,
): ToolResult {
	const parts: ToolContent[] = [...text(content, details).content];
	for (const file of files) {
		if (file.kind === "image") {
			parts.push({ type: "image", data: file.data, mimeType: file.mimeType });
		} else {
			// The rendered text already shows the file reference
			// with URL; just append the content.
			parts.push({ type: "text", text: `\n${file.text}` });
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
): Promise<DownloadedFile[]> {
	const allFiles = messages.flatMap((m) => m.files ?? []);
	if (allFiles.length === 0) return [];
	return downloadFiles(client, allFiles);
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
 * The query a search runs: the one given, or `*` when no explicit
 * query is given but structured search params (from, with, channel,
 * after, before) are present. Lets agents omit `query` when filtering
 * by operator alone.
 */
function queryOf(params: ActionParams): string | undefined {
	const query = stringParam(params, "query");
	if (query) return query;
	const hasOperator =
		stringParam(params, "from") ||
		stringParam(params, "with") ||
		stringParam(params, "channel") ||
		stringParam(params, "after") ||
		stringParam(params, "before");
	return hasOperator ? "*" : undefined;
}

/**
 * The query a search runs, or what to answer when there's nothing to
 * search by or it was asked where search can't reach.
 */
function searchQuery(
	params: ActionParams,
	resolved: ResolvedParams,
): string | ToolResult {
	const query = queryOf(params);
	if (!query) return missing("query");
	const conv = resolved.conversation;
	if (conv?.kind !== "dm" && conv?.kind !== "group_dm") return query;
	return text(
		`Slack search doesn't support ${conv.kind === "dm" ? "DM" : "group DM"} conversations. ` +
			"Use `list_messages` with the user ID as the channel instead.",
	);
}

/** The filters a message or file search shares. */
function searchFilters(params: ActionParams, resolved: ResolvedParams) {
	return {
		// Use the resolved channel name for the search operator.
		channel: resolved.conversation?.name ?? stringParam(params, "channel"),
		from: stringParam(params, "from"),
		with: stringParam(params, "with"),
		after: stringParam(params, "after"),
		before: stringParam(params, "before"),
		limit: numberParam(params, "limit"),
	};
}

/** The `search_messages` action. */
export async function handleSearchMessages(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const query = searchQuery(params, resolved);
	if (typeof query !== "string") return query;

	const result = await searchMessages(
		client,
		query,
		searchFilters(params, resolved),
	);

	// Resolve users, conversations and channel mentions so
	// the rendered output shows handles instead of raw IDs.
	await resolveMessages(client, result.messages);

	return text(renderMessageList(result.messages, result.total, result.query), {
		messages: result.messages,
		total: result.total,
		query: result.query,
	});
}

/** The `search_files` action. */
export async function handleSearchFiles(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const query = searchQuery(params, resolved);
	if (typeof query !== "string") return query;

	const result = await searchFiles(client, query, {
		...searchFilters(params, resolved),
		type: stringParam(params, "type"),
	});

	return text(renderFileList(result.files, result.total, result.query), {
		files: result.files,
		total: result.total,
		query: result.query,
	});
}

/** The `get_message` action, with its files. */
export async function handleGetMessage(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const msg = await getMessage(client, resolved.target);
	await resolveMessages(client, [msg]);
	const files = await collectFileContent(client, [msg]);
	return textWithFiles(renderMessage(msg), files, { message: msg });
}

/** The `get_thread` action, with its files. */
export async function handleGetThread(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const messages = await getThread(client, resolved.target, {
		limit: numberParam(params, "limit"),
	});
	await resolveMessages(client, messages);
	const files = await collectFileContent(client, messages);
	return textWithFiles(renderThread(messages), files, { messages });
}

/** The `list_messages` action: a conversation's history. */
export async function handleListMessages(
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
	return text(renderMessageList(messages), { messages });
}

/** The `get_channel` action. */
export async function handleGetChannel(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");

	const info = await getChannelInfo(client, resolved.conversation.id);
	return text(renderChannel(info), { channel: info });
}

/** The `get_user` action. */
export async function handleGetUser(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.userId) return missing("user");

	const info = await getUserInfo(client, resolved.userId);
	return text(renderUser(info), { user: info });
}

/** The `list_reactions` action: messages a person reacted to. */
export async function handleListReactions(
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

/** The `get_reactions` action: who reacted to a message, and how. */
export async function handleGetReactions(
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
