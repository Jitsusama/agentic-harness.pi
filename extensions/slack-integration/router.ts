/**
 * Routes incoming Slack tool actions to the appropriate
 * API handlers.
 *
 * Resolves all identifiers (channel, target, user) before
 * dispatching so handlers receive typed objects instead of
 * raw strings. Each action maps to a handler via a registry;
 * the handlers live by what they do: reading, writing one
 * message, sending a thread and uploading files.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GateDeps } from "../../lib/gate/index.ts";
import { type SlackClient, slackGateDecision } from "../../lib/slack/index.ts";
import {
	type ActionParams,
	stringParam,
	type ToolResult,
} from "../../lib/slack/types.ts";
import { boundedAnswer } from "./bounded.ts";
import {
	handleGetChannel,
	handleGetMessage,
	handleGetReactions,
	handleGetThread,
	handleGetUser,
	handleListMessages,
	handleListReactions,
	handleSearchFiles,
	handleSearchMessages,
} from "./reads.ts";
import { resolveAllParams } from "./resolve.ts";
import { type ActionHandler, text } from "./results.ts";
import { handleSendThread } from "./thread.ts";
import { handleUploadFile } from "./uploads.ts";
import {
	handleAddReaction,
	handleEditMessage,
	handleRemoveReaction,
	handleReplyToThread,
	handleSendMessage,
} from "./writes.ts";

/**
 * Route a tool action to the appropriate handler.
 *
 * Resolves all identifiers upfront, then dispatches to the
 * handler with both raw params and resolved types.
 */
export async function routeAction(
	action: string,
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
	gateDeps: GateDeps,
): Promise<ToolResult> {
	const handler = ACTION_HANDLERS.get(action);
	if (!handler) {
		return text(`Unknown action: ${action}`);
	}

	// Block content the converter cannot render as intended
	// (image embeds, pipe tables, malformed lists) before the
	// confirmation gate, so the AI fixes it against the
	// slack-guide skill and the user only ever reviews a clean
	// message. The gate relents to the confirmation gate on a
	// repeat so a model that cannot satisfy the rule does not
	// loop.
	const gatedText = collectGatedText(action, params);
	if (gatedText) {
		const decision = slackGateDecision(gatedText, gateDeps.readSignatures());
		if (decision.action === "block") {
			gateDeps.persistSignature(decision.signature);
			return text(decision.message);
		}
	}

	const resolved = await resolveAllParams(client, params);
	const result = await handler(client, params, resolved, ctx);
	const [first, ...rest] = result.content;
	if (first === undefined || first.type !== "text") return result;
	return {
		...result,
		content: [
			{ ...first, text: boundedAnswer(first.text, result.details, ctx) },
			...rest,
		],
	};
}

/**
 * Collect the message text an action will send, so the content
 * gate can scan it. Returns the empty string for actions that
 * send no markdown body. Thread and queued-reply messages are
 * joined so one gate pass reports every problem at once.
 */
function collectGatedText(action: string, params: ActionParams): string {
	const texts: string[] = [];
	const single = stringParam(params, "text");
	if (single) texts.push(single);

	if (action === "send_thread" || action === "reply_to_thread") {
		const messages = params.messages;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				if (
					message &&
					typeof message === "object" &&
					typeof (message as { text?: unknown }).text === "string"
				) {
					texts.push((message as { text: string }).text);
				}
			}
		}
	}

	return texts.join("\n\n");
}

// ── Action registry ─────────────────────────────────────

const ACTION_HANDLERS = new Map<string, ActionHandler>([
	["search_messages", handleSearchMessages],
	["search_files", handleSearchFiles],
	["get_message", handleGetMessage],
	["get_thread", handleGetThread],
	["list_messages", handleListMessages],
	["get_channel", handleGetChannel],
	["get_user", handleGetUser],
	["list_reactions", handleListReactions],
	["get_reactions", handleGetReactions],
	["send_message", handleSendMessage],
	["reply_to_thread", handleReplyToThread],
	["edit_message", handleEditMessage],
	["upload_file", handleUploadFile],
	["send_thread", handleSendThread],
	["add_reaction", handleAddReaction],
	["remove_reaction", handleRemoveReaction],
]);
