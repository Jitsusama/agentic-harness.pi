/**
 * Slack library: API client, credential state, renderers,
 * resolvers and shared types.
 *
 * Public entry point for external consumers, with
 * `ensureAuthenticated`, which runs the setup wizard in pi's own
 * interface.
 */

export * from "./api/index.ts";
export * from "./auth/index.ts";
export { formatSlackBlock } from "./block-message.ts";
export {
	extractCellText,
	extractTables,
	mrkdwnToBlocks,
	mrkdwnToCell,
	parseMrkdwnToElements,
	renderRichTextCell,
	tableToBlock,
} from "./blocks.ts";
export {
	type SlackGateDecision,
	slackGateDecision,
} from "./content-gate.ts";
export { detectSlackViolations, type SlackViolation } from "./detect.ts";
export * from "./renderers/index.ts";
export * from "./resolvers/index.ts";

// Re-export domain types (omit router internals).
export type {
	Conversation,
	ConversationKind,
	MessageTarget,
	OAuthApp,
	SlackAttachment,
	SlackChannel,
	SlackColumnSetting,
	SlackFile,
	SlackMessage,
	SlackReaction,
	SlackTable,
	SlackUser,
	StoredToken,
} from "./types.ts";
