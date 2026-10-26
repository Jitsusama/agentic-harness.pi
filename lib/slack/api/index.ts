/**
 * Slack API client and service functions.
 */

export { getChannelInfo } from "./channels.ts";
export { RateLimitError, SlackApiError, SlackClient } from "./client.ts";
export {
	type DownloadedFile,
	downloadFiles,
	type FileDownloadOptions,
	getFileSize,
	isImageMimeType,
	isTextMimeType,
	type UploadOptions,
	type UploadResult,
	uploadFiles,
} from "./files.ts";
export {
	editMessage,
	formatMentions,
	type GetMessageOptions,
	type GetThreadOptions,
	getMessage,
	getThread,
	type ListMessagesOptions,
	listMessages,
	replyToThread,
	type SendResult,
	sendMessage,
} from "./messages.ts";
export {
	addReaction,
	getReactions,
	listReactions,
	type MessageReactions,
	type ReactedMessage,
	removeReaction,
} from "./reactions.ts";
export { resolveMessages } from "./resolve-messages.ts";
export {
	type FileSearchResult,
	type MessageSearchResult,
	type SearchFilesOptions,
	type SearchMessagesOptions,
	type SearchPageInfo,
	type SlackFileResult,
	searchFiles,
	searchMessages,
} from "./search.ts";
export { getUserInfo } from "./users.ts";
