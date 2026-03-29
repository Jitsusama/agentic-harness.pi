/**
 * Slack library: API client, authentication, renderers,
 * resolvers and shared types.
 *
 * Public entry point for external consumers.
 */

export * from "./api/index.js";
export * from "./auth/index.js";
export * from "./renderers/index.js";
export * from "./resolvers/index.js";

// Re-export domain types (omit router internals).
export type {
	Conversation,
	ConversationKind,
	MessageTarget,
	OAuthApp,
	SlackAttachment,
	SlackChannel,
	SlackFile,
	SlackMessage,
	SlackReaction,
	SlackUser,
	StoredToken,
} from "./types.js";
