/**
 * Slack API client and service functions.
 */

export { getChannelInfo } from "./channels.js";
export { SlackClient } from "./client.js";
export {
	getMessage,
	getThread,
	listMessages,
	replyToThread,
	sendMessage,
	type SendResult,
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
	searchFiles,
	searchMessages,
	type SlackFileResult,
} from "./search.js";
export { getUserInfo } from "./users.js";
