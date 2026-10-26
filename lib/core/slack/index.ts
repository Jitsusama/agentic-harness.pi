/**
 * Slack library: API client, credential state, renderers,
 * resolvers and shared types.
 *
 * Public entry point for external consumers. The interactive auth
 * orchestration (`ensureAuthenticated`, the setup wizard) needs a
 * host's UI and is not here; an adapter builds that from the
 * pieces `./auth` exports.
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
