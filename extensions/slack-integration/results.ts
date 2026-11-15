/**
 * What a Slack action is given and answers with.
 *
 * Every handler takes the same four things and answers with a tool
 * result; these say once how a plain answer, a missing parameter and
 * a conversation's name read.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SlackClient } from "../../lib/slack/index.ts";
import type {
	ActionParams,
	Conversation,
	ResolvedParams,
	ToolResult,
} from "../../lib/slack/types.ts";

/** Handler function that processes a Slack action. */
export type ActionHandler = (
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
) => Promise<ToolResult>;

/** Shorthand for a simple text result. */
export function text(content: string, details?: unknown): ToolResult {
	return {
		content: [{ type: "text", text: content }],
		details,
	};
}

/** Shorthand for missing parameter errors. */
export function missing(param: string): ToolResult {
	return text(`Missing required parameter: ${param}`);
}

/** The name a gate and an answer call a conversation by. */
export function nameOf(conversation: Conversation): string {
	return conversation.displayName ?? conversation.id;
}
