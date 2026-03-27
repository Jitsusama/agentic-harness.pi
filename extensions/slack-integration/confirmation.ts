/**
 * Confirmation gates for Slack write operations.
 *
 * Each gate shows the user what will happen and lets them
 * approve, reject, annotate or redirect — matching the
 * guardian pattern used elsewhere in the harness.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import { promptSingle } from "../lib/ui/panel.js";
import { formatRedirectReason } from "../lib/ui/redirect.js";
import type { KeyAction } from "../lib/ui/types.js";

/** Reject action shown in every confirmation gate. */
const REJECT_ACTION: KeyAction[] = [{ key: "r", label: "Reject" }];

/** Result from a confirmation gate. */
export type ConfirmResult<T> =
	| { approved: true; data: T }
	| { approved: false; redirect: string }
	| null;

/** Shorthand for a redirect result. */
function redirect(note: string, context: string): ConfirmResult<never> {
	return { approved: false, redirect: formatRedirectReason(note, context) };
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

	const context = `Send message to ${conversationName}:\n${text.slice(0, 200)}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Send Slack Message")),
				"",
				` ${theme.fg("muted", "To:")} ${conversationName}`,
				"",
			];
			for (const line of renderMarkdown(text, theme, width)) {
				lines.push(line);
			}
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return redirect(result.note, context);
	}

	if (result.type === "action") {
		if (result.key === "r") {
			if (result.note) return redirect(result.note, context);
			return redirect("User rejected. Ask for guidance.", context);
		}
		// Enter (approve)
		if (result.note) return redirect(result.note, context);
		return { approved: true, data: { text } };
	}

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
	if (!ctx.hasUI) return { approved: true, data: { text } };

	const context = `Reply in ${conversationName} thread ${threadTs}:\n${text.slice(0, 200)}`;

	const result = await promptSingle(ctx, {
		content: (theme, width) => {
			const lines = [
				theme.fg("accent", theme.bold(" Reply to Thread")),
				"",
				` ${theme.fg("muted", "In:")} ${conversationName}`,
				` ${theme.fg("muted", "Thread:")} ${threadTs}`,
				"",
			];
			for (const line of renderMarkdown(text, theme, width)) {
				lines.push(line);
			}
			return lines;
		},
		actions: REJECT_ACTION,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return redirect(result.note, context);
	}

	if (result.type === "action") {
		if (result.key === "r") {
			if (result.note) return redirect(result.note, context);
			return redirect("User rejected. Ask for guidance.", context);
		}
		// Enter (approve)
		if (result.note) return redirect(result.note, context);
		return { approved: true, data: { text } };
	}

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
	const context = `${verb} :${emoji}: reaction in ${conversationName}`;

	const result = await promptSingle(ctx, {
		content: (theme) => [
			theme.fg("accent", theme.bold(` ${verb} Reaction`)),
			"",
			` ${theme.fg("muted", "In:")} ${conversationName}`,
			` ${theme.fg("muted", "Message:")} ${ts}`,
			` ${theme.fg("muted", "Emoji:")} :${emoji}:`,
		],
		actions: REJECT_ACTION,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return redirect(result.note, context);
	}

	if (result.type === "action") {
		if (result.key === "r") {
			if (result.note) return redirect(result.note, context);
			return redirect("User rejected. Ask for guidance.", context);
		}
		// Enter (approve)
		if (result.note) return redirect(result.note, context);
		return { approved: true, data: true };
	}

	return { approved: true, data: true };
}
