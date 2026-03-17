/**
 * Thread gate — decision panel for a single review thread.
 *
 * Shows the original comment, code context, LLM recommendation,
 * and full thread history. The user picks an action: implement,
 * implement later, reply, defer, or skip.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderCode, renderMarkdown } from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import type { CodeContext } from "../navigation.js";
import type { Review, Thread } from "../state.js";

/** User's decision from the thread gate. */
export type ThreadGateChoice =
	| { action: "implement" }
	| { action: "implement-later" }
	| { action: "reply" }
	| { action: "defer" }
	| { action: "skip" }
	| { action: "steer"; feedback: string }
	| null;

/** Map from prompt action keys to domain actions. */
const ACTION_BY_KEY: Record<string, ThreadGateChoice["action" & string]> = {
	i: "implement",
	l: "implement-later",
	r: "reply",
	d: "defer",
	k: "skip",
};

/**
 * Show the thread decision gate. Displays the original comment,
 * code context, LLM recommendation, and thread history. Returns
 * the user's chosen action, or null if cancelled.
 */
export async function showThreadGate(
	ctx: ExtensionContext,
	thread: Thread,
	review: Review | undefined,
	codeContext: CodeContext | null,
	recommendation: string,
	progressLine: string,
): Promise<ThreadGateChoice> {
	const contextLine = thread.line || thread.originalLine || 0;
	const original = thread.comments.find((c) => c.inReplyTo === null);

	const result = await prompt(ctx, {
		content: (theme, width) => {
			const lines: string[] = [];

			// Header
			lines.push(theme.fg("accent", theme.bold(progressLine)));
			lines.push(
				theme.fg(
					"muted",
					`${thread.file}:${contextLine} • ${review?.author ?? thread.reviewer} • ${thread.reviewState}`,
				),
			);
			lines.push("");

			// Original comment
			if (original) {
				lines.push(theme.fg("dim", `${original.author}:`));
				lines.push(...renderMarkdown(original.body, theme, width));
				lines.push("");
			}

			// Code context
			if (codeContext) {
				lines.push(
					...renderCode(codeContext.source, theme, width, {
						startLine: codeContext.startLine,
						highlightLines: new Set([codeContext.highlightLine]),
						language: codeContext.language,
					}),
				);
				lines.push("");
			}

			// LLM analysis and recommendation
			if (recommendation) {
				lines.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
				lines.push("");
				lines.push(...renderMarkdown(recommendation, theme, width));
			}

			// Full thread conversation (if more than just the original)
			if (thread.comments.length > 1) {
				lines.push("");
				lines.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
				lines.push(theme.fg("dim", "Thread History:"));
				lines.push("");
				for (const comment of thread.comments) {
					const isOrig = comment.inReplyTo === null;
					const tag = isOrig ? "▸" : "  ↳";
					lines.push(
						theme.fg(
							isOrig ? "accent" : "muted",
							`${tag} ${comment.author} (${comment.createdAt}):`,
						),
					);
					lines.push(...renderMarkdown(comment.body, theme, width));
					lines.push("");
				}
			}

			return lines;
		},
		actions: [
			{ key: "i", label: "Implement Now" },
			{ key: "l", label: "Implement Later" },
			{ key: "r", label: "Reply" },
			{ key: "d", label: "Defer" },
			{ key: "k", label: "sKip" },
		],
		allowHScroll: true,
	});

	if (!result) return null;

	if (result.type === "steer") {
		return { action: "steer", feedback: result.note };
	}

	const action = ACTION_BY_KEY[result.value] ?? "skip";
	return { action };
}
