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

/** Classification of a Slack conversation. */
export type ConversationKind = "channel" | "dm" | "group_dm";

/**
 * A Slack conversation at any level of resolution.
 *
 * Created during input resolution (router) and enriched
 * during output formatting (post-fetch message rendering).
 * Fields that aren't available yet are undefined.
 */
export interface Conversation {
	/** Slack conversation ID (C..., D..., G...). Always present. */
	id: string;
	/** Raw Slack channel name (e.g. "gitstream"). Undefined for DMs. */
	name?: string;
	/** What kind of conversation this is. */
	kind: ConversationKind;
	/** Human-readable name: "#gitstream", "@chao.duan", "@a, @b, @c". */
	displayName?: string;
	/** The other person's user ID. Only set when kind is "dm". */
	dmUserId?: string;
}

/** A message target: a conversation plus a timestamp. */
export interface MessageTarget {
	conversation: Conversation;
	ts: string;
}

/** Resolved identifiers from tool parameters. */
export interface ResolvedParams {
	/** Resolved conversation (from `channel` param, `target`, or `channel` + `ts`). */
	conversation?: Conversation;
	/** Resolved message target (from `target` param or `channel` + `ts`). */
	target?: MessageTarget;
	/** Resolved user ID (from `user` param). */
	userId?: string;
}

/** An attachment or link unfurl on a Slack message. */
export interface SlackAttachment {
	title?: string;
	text?: string;
	fallback?: string;
	fromUrl?: string;
	imageUrl?: string;
}

/** A file attached to a Slack message. */
export interface SlackFile {
	name: string;
	mimetype?: string;
	url?: string;
}

/** Per-column display settings for a Slack table block. */
export interface SlackColumnSetting {
	/** Text alignment: "left" (default), "center", or "right". */
	align?: "left" | "center" | "right";
	/** Whether text wraps instead of truncating. */
	isWrapped?: boolean;
}

/**
 * A table extracted from or destined for a Slack table block.
 *
 * When reading, columns and rows contain rendered text
 * (rich text elements converted to readable strings).
 * When sending, they contain mrkdwn strings that get
 * converted to Block Kit elements.
 */
export interface SlackTable {
	/** Header row labels. */
	columns: string[];
	/** Data rows. Each row has the same length as columns. */
	rows: string[][];
	/** Per-column settings (positional). Use null to skip a column. */
	columnSettings?: (SlackColumnSetting | null)[];
}

/** A Slack message as returned by the API. */
export interface SlackMessage {
	ts: string;
	text: string;
	user?: string;
	/** The conversation this message belongs to. */
	conversation?: Conversation;
	threadTs?: string;
	replyCount?: number;
	/** True when this message started a thread (threadTs === ts). */
	isThreadParent?: boolean;
	reactions?: SlackReaction[];
	attachments?: SlackAttachment[];
	files?: SlackFile[];
	/** Tables extracted from Block Kit table blocks. */
	tables?: SlackTable[];
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
