/**
 * Shared types for the Slack integration extension.
 */

/** OAuth app credentials (client ID + secret). */
export interface OAuthApp {
	readonly clientId: string;
	readonly clientSecret: string;
}

/**
 * Stored Slack credentials.
 *
 * Supports two auth modes:
 *   - OAuth user tokens (xoxp-): proper OAuth2 flow, no cookie needed
 *   - Browser session tokens (xoxc-): extracted from browser, requires cookie
 *
 * Enterprise workspaces often block app creation, making browser
 * session tokens the only viable option.
 */
export interface StoredToken {
	accessToken: string;
	cookie?: string;
	userId: string;
	teamId: string;
	teamName?: string;
	scopes: string;
}

/** Parameters passed to router actions. */
export type ActionParams = Record<string, unknown>;

/** Extract a string parameter, returning undefined if absent or wrong type. */
export function stringParam(
	params: ActionParams,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

/** Extract a number parameter, returning undefined if absent or wrong type. */
export function numberParam(
	params: ActionParams,
	key: string,
): number | undefined {
	const value = params[key];
	return typeof value === "number" ? value : undefined;
}

/** Result of a tool execution. */
export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

/** Classification of a Slack channel. */
export type ChannelKind = "channel" | "dm" | "group_dm";

/** A Slack message as returned by the API. */
export interface SlackMessage {
	ts: string;
	text: string;
	user?: string;
	channel?: string;
	channelName?: string;
	channelKind?: ChannelKind;
	threadTs?: string;
	replyCount?: number;
	reactions?: SlackReaction[];
	permalink?: string;
}

/** A reaction on a Slack message. */
export interface SlackReaction {
	name: string;
	count: number;
	users: string[];
}

/** Channel metadata. */
export interface SlackChannel {
	id: string;
	name: string;
	topic?: string;
	purpose?: string;
	memberCount?: number;
	isArchived: boolean;
	isPrivate: boolean;
	created?: number;
}

/** User profile. */
export interface SlackUser {
	id: string;
	name: string;
	realName?: string;
	displayName?: string;
	title?: string;
	email?: string;
	isBot: boolean;
	isAdmin: boolean;
	timezone?: string;
	statusText?: string;
	statusEmoji?: string;
	deleted: boolean;
}

/** Search result metadata. */
export interface SearchResult {
	messages: SlackMessage[];
	total: number;
}
