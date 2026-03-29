/**
 * Slack reactions API: add, remove, list and get.
 */

import type { SlackClient } from "./client.js";

/**
 * Add a reaction to a message.
 */
export async function addReaction(
	client: SlackClient,
	channel: string,
	ts: string,
	emoji: string,
	signal?: AbortSignal,
): Promise<void> {
	const name = emoji.replace(/^:/, "").replace(/:$/, "");
	await client.call("reactions.add", { channel, timestamp: ts, name }, signal);
}

/**
 * Remove a reaction from a message.
 */
export async function removeReaction(
	client: SlackClient,
	channel: string,
	ts: string,
	emoji: string,
	signal?: AbortSignal,
): Promise<void> {
	const name = emoji.replace(/^:/, "").replace(/:$/, "");
	await client.call(
		"reactions.remove",
		{ channel, timestamp: ts, name },
		signal,
	);
}

/** Reaction details on a message. */
export interface MessageReactions {
	ts: string;
	channel: string;
	user?: string;
	text?: string;
	reactions: Array<{ name: string; count: number; users: string[] }>;
}

/**
 * Get reactions on a specific message.
 */
export async function getReactions(
	client: SlackClient,
	channel: string,
	ts: string,
	signal?: AbortSignal,
): Promise<MessageReactions> {
	const response = await client.call<{
		message: {
			ts: string;
			user?: string;
			text?: string;
			reactions?: Array<{ name: string; count: number; users: string[] }>;
		};
	}>("reactions.get", { channel, timestamp: ts, full: true }, signal);

	const msg = response.message ?? {};
	return {
		ts: msg.ts ?? ts,
		channel,
		user: msg.user,
		text: msg.text,
		reactions: msg.reactions ?? [],
	};
}

/** A message the user reacted to. */
export interface ReactedMessage {
	ts: string;
	channel?: string;
	user?: string;
	text?: string;
	reactions: Array<{ name: string; count: number; users: string[] }>;
}

/**
 * List messages the authenticated user (or a specified user) has reacted to.
 */
export async function listReactions(
	client: SlackClient,
	opts: { user?: string; limit?: number } = {},
	signal?: AbortSignal,
): Promise<ReactedMessage[]> {
	const limit = Math.min(opts.limit || 20, 100);

	const response = await client.call<{
		items: Array<{
			type: string;
			channel?: string;
			message?: {
				ts: string;
				user?: string;
				text?: string;
				reactions?: Array<{ name: string; count: number; users: string[] }>;
			};
		}>;
	}>("reactions.list", { user: opts.user, limit, full: true }, signal);

	return (response.items ?? [])
		.filter((item) => item.type === "message" && item.message)
		.map((item) => {
			const msg = item.message as NonNullable<typeof item.message>;
			return {
				ts: msg.ts,
				channel: item.channel,
				user: msg.user,
				text: msg.text,
				reactions: msg.reactions ?? [],
			};
		});
}
