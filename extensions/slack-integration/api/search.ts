/**
 * Slack search API: messages and files.
 *
 * Builds queries from structured parameters, including Slack
 * search operators (from:, in:, after:, before:). Caches
 * channel and user mappings found in results.
 */

import { cacheChannel } from "../resolvers/channel.js";
import { cacheUser } from "../resolvers/user.js";
import type { SlackMessage } from "../types.js";
import type { SlackClient } from "./client.js";
import { cacheChannelName } from "./resolve-channels.js";

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

/** Search result with messages and total count. */
export interface MessageSearchResult {
	messages: SlackMessage[];
	total: number;
}

/**
 * Search Slack messages.
 *
 * Supports Slack search operators embedded in the query string,
 * plus structured channel/from/after/before parameters that get
 * appended as operators.
 */
export async function searchMessages(
	client: SlackClient,
	query: string,
	opts: {
		channel?: string;
		from?: string;
		with?: string;
		after?: string;
		before?: string;
		limit?: number;
	} = {},
	signal?: AbortSignal,
): Promise<MessageSearchResult> {
	const fullQuery = buildQuery(query, opts);
	const limit = Math.min(opts.limit || 20, 100);

	const response = await client.call<{
		messages: {
			total: number;
			matches: Array<{
				ts: string;
				channel: { id: string; name: string };
				user?: string;
				username?: string;
				text: string;
				permalink: string;
				thread_ts?: string;
				reply_count?: number;
			}>;
		};
	}>(
		"search.messages",
		{
			query: fullQuery,
			count: limit,
			sort: "timestamp",
			sort_dir: "desc",
		},
		signal,
	);

	const matches = response.messages?.matches ?? [];

	// Cache channel and user mappings from results.
	for (const m of matches) {
		if (m.channel?.id && m.channel?.name) {
			cacheChannel(m.channel.name, m.channel.id);
			cacheChannelName(m.channel.id, m.channel.name);
		}
		if (m.user && m.username) {
			cacheUser(m.username, m.user);
		}
	}

	const messages: SlackMessage[] = matches.map((m) => ({
		ts: m.ts,
		text: m.text ?? "",
		user: m.user,
		channel: m.channel?.id,
		channelName: m.channel?.name,
		threadTs: m.thread_ts,
		replyCount: m.reply_count,
		permalink: m.permalink,
	}));

	return {
		messages,
		total: response.messages?.total ?? 0,
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
}

/** Search Slack files. */
export async function searchFiles(
	client: SlackClient,
	query: string,
	opts: {
		channel?: string;
		from?: string;
		with?: string;
		after?: string;
		before?: string;
		type?: string;
		limit?: number;
	} = {},
	signal?: AbortSignal,
): Promise<FileSearchResult> {
	const fullQuery = buildQuery(query, opts);
	const limit = Math.min(opts.limit || 20, 100);

	const response = await client.call<{
		files: {
			total: number;
			matches: Array<{
				id: string;
				name: string;
				title?: string;
				mimetype?: string;
				size?: number;
				user?: string;
				permalink?: string;
			}>;
		};
	}>(
		"search.files",
		{
			query: fullQuery,
			count: limit,
			sort: "timestamp",
			sort_dir: "desc",
		},
		signal,
	);

	const matches = response.files?.matches ?? [];

	return {
		files: matches.map((f) => ({
			id: f.id,
			name: f.name,
			title: f.title,
			mimetype: f.mimetype,
			size: f.size,
			user: f.user,
			permalink: f.permalink,
		})),
		total: response.files?.total ?? 0,
	};
}
