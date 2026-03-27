/**
 * Confirmation gates for Slack write operations.
 *
 * Uses promptSingle from the shared panel library, matching
 * the google-workspace-integration pattern. Each gate shows
 * the user what will happen and lets them approve, cancel, or
 * redirect (provide feedback for the agent to adjust).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promptSingle } from "../lib/ui/panel.js";
import { formatRedirectReason } from "../lib/ui/redirect.js";
import type { PromptResult } from "../lib/ui/types.js";

/** Result from a confirmation gate. */
export type ConfirmResult<T> =
	| { approved: true; data: T }
	| { approved: false; redirect: string }
	| null;

/** Extract redirect feedback from a prompt result. */
function extractRedirect(
	result: PromptResult | null,
	context: string,
): { approved: false; redirect: string } | null {
	if (!result) return null;
	if (result.type === "redirect") {
		return {
			approved: false,
			redirect: formatRedirectReason(result.note ?? "", context),
		};
	}
	if (result.note) {
		return {
			approved: false,
			redirect: formatRedirectReason(result.note, context),
		};
	}
	return null;
}

/**
 * Confirm sending a message to a conversation.
 */
export async function confirmSendMessage(
	ctx: ExtensionContext,
	conversationName: string,
	text: string,
): Promise<ConfirmResult<{ text: string }>> {
	if (!ctx.hasUI) return { approved: true, data: { text } };

	const result = await promptSingle(ctx, {
		content: (theme) => {
			const lines = [
				theme.fg("accent", theme.bold(" Send Slack Message")),
				"",
				` ${theme.fg("muted", "To:")} ${conversationName}`,
				"",
			];
			const textLines = text.split("\n");
			const preview = textLines.slice(0, 15);
			for (const line of preview) {
				lines.push(` ${line}`);
			}
			if (textLines.length > 15) {
				lines.push(
					` ${theme.fg("dim", `… (${textLines.length - 15} more lines)`)}`,
				);
			}
			return lines;
		},
	});

	if (!result) return null;
	const redirect = extractRedirect(
		result,
		`Send message to ${conversationName}:\n${text.slice(0, 200)}`,
	);
	if (redirect) return redirect;
	return { approved: true, data: { text } };
}

/**
 * Confirm replying to a thread.
 */
export async function confirmReply(
	ctx: ExtensionContext,
	conversationName: string,
	threadTs: string,
	text: string,
): Promise<ConfirmResult<{ text: string }>> {
	if (!ctx.hasUI) {
		return { approved: true, data: { text } };
	}

	const result = await promptSingle(ctx, {
		content: (theme) => {
			const lines = [
				theme.fg("accent", theme.bold(" Reply to Thread")),
				"",
				` ${theme.fg("muted", "In:")} ${conversationName}`,
				` ${theme.fg("muted", "Thread:")} ${threadTs}`,
				"",
			];
			const textLines = text.split("\n");
			const preview = textLines.slice(0, 15);
			for (const line of preview) {
				lines.push(` ${line}`);
			}
			if (textLines.length > 15) {
				lines.push(
					` ${theme.fg("dim", `… (${textLines.length - 15} more lines)`)}`,
				);
			}
			return lines;
		},
	});

	if (!result) return null;
	const redirect = extractRedirect(
		result,
		`Reply in ${conversationName} thread ${threadTs}:\n${text.slice(0, 200)}`,
	);
	if (redirect) return redirect;
	return { approved: true, data: { text } };
}

/**
 * Confirm adding or removing a reaction.
 */
export async function confirmReaction(
	ctx: ExtensionContext,
	conversationName: string,
	ts: string,
	emoji: string,
	action: "add" | "remove",
): Promise<ConfirmResult<true>> {
	if (!ctx.hasUI) return { approved: true, data: true };

	const verb = action === "add" ? "Add" : "Remove";
	const result = await promptSingle(ctx, {
		content: (theme) => [
			theme.fg("accent", theme.bold(` ${verb} Reaction`)),
			"",
			` ${theme.fg("muted", "In:")} ${conversationName}`,
			` ${theme.fg("muted", "Message:")} ${ts}`,
			` ${theme.fg("muted", "Emoji:")} :${emoji}:`,
		],
	});

	if (!result) return null;
	const redirect = extractRedirect(
		result,
		`${verb} :${emoji}: reaction in ${conversationName}`,
	);
	if (redirect) return redirect;
	return { approved: true, data: true };
}
