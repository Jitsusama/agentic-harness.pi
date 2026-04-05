/**
 * Slack API client and service functions.
 */

export { getChannelInfo } from "./channels.js";
export { RateLimitError, SlackClient } from "./client.js";
export {
	getMessage,
	getThread,
	listMessages,
	replyToThread,
	type SendResult,
	sendMessage,
} from "./messages.js";
export {
	addReaction,
	getReactions,
	listReactions,
	type MessageReactions,
	type ReactedMessage,
	removeReaction,
} from "./reactions.js";
export {
	type FileSearchResult,
	type MessageSearchResult,
	type SearchPageInfo,
	type SlackFileResult,
	searchFiles,
	searchMessages,
} from "./search.js";
export { getUserInfo } from "./users.js";
