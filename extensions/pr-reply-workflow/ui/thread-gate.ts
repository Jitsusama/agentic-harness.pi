/**
 * Thread gate: decision panel for a single review thread.
 *
 * Shows the original comment, code context, LLM recommendation,
 * and full thread history. Enter = implement. Letter keys for
 * reply and pass.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderCode, renderMarkdown } from "../../lib/ui/content-renderer.js";
import { promptSingle } from "../../lib/ui/panel.js";
import type { CodeContext } from "../code-context.js";
import type { ReceivedReview, ReviewThread } from "../state.js";

/** User's decision from the thread gate. */
export type ThreadGateChoice =
	| { action: "implement" }
	| { action: "reply" }
	| { action: "pass" }
	| { action: "redirect"; feedback: string }
	| null;

/** Map from prompt action keys to domain actions. */
const ACTION_BY_KEY: Record<string, ThreadGateChoice["action" & string]> = {
	w: "reply",
	p: "pass",
};

/**
 * Show the thread decision gate. Displays the original comment,
 * code context, LLM recommendation, and thread history. Returns
 * the user's chosen action, or null if cancelled.
 */
export async function showThreadGate(
	ctx: ExtensionContext,
	thread: ReviewThread,
	review: ReceivedReview | undefined,
	codeContext: CodeContext | null,
	recommendation: string,
	progressLine: string,
): Promise<ThreadGateChoice> {
	const contextLine = thread.line || thread.originalLine || 0;
	const original = thread.comments.find((c) => c.inReplyTo === null);

	const result = await promptSingle(ctx, {
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
			{ key: "w", label: "Write" },
			{ key: "p", label: "Pass" },
		],
		allowHScroll: true,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return { action: "redirect", feedback: result.note };
	}

	// Enter = implement (default forward action)
	if (result.key === "__enter__") return { action: "implement" };

	const action = ACTION_BY_KEY[result.key] ?? "pass";
	return { action };
}
