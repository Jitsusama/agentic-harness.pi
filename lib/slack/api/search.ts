/**
 * Slack search API: messages and files.
 *
 * Builds queries from structured parameters, including Slack
 * search operators (from:, in:, after:, before:). Auto-paginates
 * through results using Slack's traditional paging (page +
 * count). Caches channel and user mappings found in results.
 */

import { cacheChannelName } from "../resolvers/conversation.js";
import { cacheUser } from "../resolvers/user.js";
import type { Conversation, SlackMessage } from "../types.js";
import type { SlackClient } from "./client.js";
import { cacheConversationFromSearch } from "./resolve-conversations.js";

/** Maximum results per page (Slack API hard limit). */
const MAX_PER_PAGE = 100;

/** Maximum page number (Slack API hard limit). */
const MAX_PAGE = 100;

/** Default number of results when no limit is specified. */
const DEFAULT_LIMIT = 20;

/** Build a search query string from structured parameters. */
function buildQuery(
	query: string,
	opts: {
		channel?: string;
		from?: string;
		with?: string;
		after?: string;
		before?: string;
	},
): string {
	let q = query;
	if (opts.channel) {
		const ch = opts.channel.startsWith("#") ? opts.channel : `#${opts.channel}`;
		q += ` in:${ch}`;
	}
	if (opts.from) {
		const user = opts.from.startsWith("@") ? opts.from.slice(1) : opts.from;
		q += ` from:${user}`;
	}
	if (opts.with) {
		const user = opts.with.startsWith("@") ? opts.with.slice(1) : opts.with;
		q += ` with:${user}`;
	}
	if (opts.after) q += ` after:${opts.after}`;
	if (opts.before) q += ` before:${opts.before}`;
	return q;
}

/** Search result with messages, total count and the query sent to Slack. */
export interface MessageSearchResult {
	messages: SlackMessage[];
	total: number;
	query: string;
}

/** Page metadata passed to the `onPage` callback. */
export interface SearchPageInfo {
	/** Current page number (1-indexed). */
	page: number;
	/** Total number of pages available. */
	totalPages: number;
	/** Total number of matching messages across all pages. */
	total: number;
}

/** Shape of a message match from the Slack search API. */
interface MessageMatch {
	ts: string;
	channel: { id: string; name: string };
	user?: string;
	username?: string;
	text: string;
	permalink: string;
	thread_ts?: string;
	reply_count?: number;
}

/** Cache conversation and user mappings from a search match. */
function cacheMatchMappings(m: MessageMatch): void {
	if (m.channel?.id && m.channel?.name) {
		cacheChannelName(m.channel.name, m.channel.id);
		cacheConversationFromSearch(m.channel.id, m.channel.name);
	}
	if (m.user && m.username) {
		cacheUser(m.username, m.user);
	}
}

/** Convert a Slack search match to our message type. */
function matchToMessage(m: MessageMatch): SlackMessage {
	const conversation: Conversation | undefined = m.channel?.id
		? {
				id: m.channel.id,
				name: m.channel.name,
				kind: m.channel.name?.startsWith("mpdm-") ? "group_dm" : "channel",
				displayName: m.channel.name
					? m.channel.name.startsWith("mpdm-")
						? undefined
						: `#${m.channel.name}`
					: undefined,
			}
		: undefined;

	return {
		ts: m.ts,
		text: m.text ?? "",
		user: m.user,
		conversation,
		threadTs: m.thread_ts,
		replyCount: m.reply_count,
		isThreadParent: m.thread_ts !== undefined && m.thread_ts === m.ts,
		permalink: m.permalink,
	};
}

/** Slack search API response shape for messages. */
interface MessageSearchResponse {
	messages: {
		total: number;
		paging: { count: number; total: number; page: number; pages: number };
		matches: MessageMatch[];
	};
}

/** Options for searching messages. */
export interface SearchMessagesOptions {
	channel?: string;
	from?: string;
	with?: string;
	after?: string;
	before?: string;
	limit?: number;
	signal?: AbortSignal;
	/**
	 * Called after each page is fetched, deduplicated and
	 * cached. Receives only new (non-duplicate) messages
	 * from that page. Useful for progress reporting or
	 * incremental processing without reimplementing
	 * pagination.
	 */
	onPage?: (messages: SlackMessage[], pageInfo: SearchPageInfo) => void;
}

/**
 * Search Slack messages with automatic pagination.
 *
 * Fetches pages of up to 100 results until the requested limit
 * is reached or all pages are exhausted. Pass `limit: 0` for
 * unlimited (up to Slack's ceiling of 10,000 results).
 */
export async function searchMessages(
	client: SlackClient,
	query: string,
	opts: SearchMessagesOptions = {},
): Promise<MessageSearchResult> {
	const fullQuery = buildQuery(query, opts);
	const targetLimit =
		opts.limit === 0 ? Number.POSITIVE_INFINITY : opts.limit || DEFAULT_LIMIT;
	const perPage = Math.min(targetLimit, MAX_PER_PAGE);

	const allMessages: SlackMessage[] = [];
	const seen = new Set<string>();
	let page = 1;
	let totalPages = 1;
	let total = 0;

	while (
		allMessages.length < targetLimit &&
		page <= totalPages &&
		page <= MAX_PAGE
	) {
		if (opts.signal?.aborted) break;

		const response = await client.call<MessageSearchResponse>(
			"search.messages",
			{
				query: fullQuery,
				count: perPage,
				page,
				sort: "timestamp",
				sort_dir: "desc",
			},
			opts.signal,
		);

		const matches = response.messages?.matches ?? [];
		total = response.messages?.total ?? 0;
		totalPages = response.messages?.paging?.pages ?? 1;

		if (matches.length === 0) break;

		const pageMessages: SlackMessage[] = [];
		for (const m of matches) {
			cacheMatchMappings(m);

			if (seen.has(m.ts)) continue;
			seen.add(m.ts);

			const msg = matchToMessage(m);
			allMessages.push(msg);
			pageMessages.push(msg);
			if (allMessages.length >= targetLimit) break;
		}

		if (opts.onPage && pageMessages.length > 0) {
			opts.onPage(pageMessages, { page, totalPages, total });
		}

		page++;
	}

	return {
		messages: allMessages,
		total,
		query: fullQuery,
	};
}

/** File metadata from a file search. */
export interface SlackFileResult {
	id: string;
	name: string;
	title?: string;
	mimetype?: string;
	size?: number;
	user?: string;
	permalink?: string;
}

/** File search result. */
export interface FileSearchResult {
	files: SlackFileResult[];
	total: number;
	query: string;
}

/** Shape of a file match from the Slack search API. */
interface FileMatch {
	id: string;
	name: string;
	title?: string;
	mimetype?: string;
	size?: number;
	user?: string;
	permalink?: string;
}

/** Slack search API response shape for files. */
interface FileSearchResponse {
	files: {
		total: number;
		paging: { count: number; total: number; page: number; pages: number };
		matches: FileMatch[];
	};
}

/** Options for searching files. */
export interface SearchFilesOptions {
	channel?: string;
	from?: string;
	with?: string;
	after?: string;
	before?: string;
	type?: string;
	limit?: number;
	signal?: AbortSignal;
}

/**
 * Search Slack files with automatic pagination.
 *
 * Fetches pages of up to 100 results until the requested limit
 * is reached or all pages are exhausted. Pass `limit: 0` for
 * unlimited (up to Slack's ceiling of 10,000 results).
 */
export async function searchFiles(
	client: SlackClient,
	query: string,
	opts: SearchFilesOptions = {},
): Promise<FileSearchResult> {
	const fullQuery = buildQuery(query, opts);
	const targetLimit =
		opts.limit === 0 ? Number.POSITIVE_INFINITY : opts.limit || DEFAULT_LIMIT;
	const perPage = Math.min(targetLimit, MAX_PER_PAGE);

	const allFiles: SlackFileResult[] = [];
	const seen = new Set<string>();
	let page = 1;
	let totalPages = 1;
	let total = 0;

	while (
		allFiles.length < targetLimit &&
		page <= totalPages &&
		page <= MAX_PAGE
	) {
		if (opts.signal?.aborted) break;

		const response = await client.call<FileSearchResponse>(
			"search.files",
			{
				query: fullQuery,
				count: perPage,
				page,
				sort: "timestamp",
				sort_dir: "desc",
			},
			opts.signal,
		);

		const matches = response.files?.matches ?? [];
		total = response.files?.total ?? 0;
		totalPages = response.files?.paging?.pages ?? 1;

		if (matches.length === 0) break;

		for (const f of matches) {
			if (seen.has(f.id)) continue;
			seen.add(f.id);

			allFiles.push({
				id: f.id,
				name: f.name,
				title: f.title,
				mimetype: f.mimetype,
				size: f.size,
				user: f.user,
				permalink: f.permalink,
			});
			if (allFiles.length >= targetLimit) break;
		}

		page++;
	}

	return {
		files: allFiles,
		total,
		query: fullQuery,
	};
}
