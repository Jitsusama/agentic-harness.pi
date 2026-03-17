/**
 * Reply review panel — approve, reject, or steer a draft reply
 * before posting it to GitHub.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import { formatSteer } from "../../lib/ui/steer.js";
import type { Thread } from "../state.js";

/** Result of the reply review: approved text, or a reason for rejection. */
export type ReplyReviewResult =
	| { approved: true }
	| { approved: false; reason: string };

/**
 * Show the reply review panel. Displays the draft reply with
 * context about who we're replying to. Returns whether the user
 * approved or why they rejected.
 */
export async function showReplyReview(
	ctx: ExtensionContext,
	thread: Thread,
	draftReply: string,
): Promise<ReplyReviewResult> {
	const topComment = thread.comments.find((c) => c.inReplyTo === null);
	if (!topComment) {
		return {
			approved: false,
			reason: "Cannot find original comment to reply to.",
		};
	}

	const result = await prompt(ctx, {
		content: (theme, width) => {
			const lines: string[] = [];
			lines.push(
				theme.fg(
					"dim",
					`Replying to ${topComment.author} on ${thread.file}:${thread.line}`,
				),
			);
			lines.push("");
			lines.push(...renderMarkdown(draftReply, theme, width));
			return lines;
		},
		actions: [
			{ key: "a", label: "Approve" },
			{ key: "r", label: "Reject" },
		],
	});

	if (!result) {
		return { approved: false, reason: "User cancelled the reply review." };
	}

	if (result.type === "steer") {
		const steerResult = formatSteer(
			result.note,
			`Original reply:\n${draftReply}`,
		);
		return { approved: false, reason: steerResult.reason };
	}

	if (result.type === "action" && result.value === "r") {
		const reason = result.note
			? `User rejected: ${result.note}`
			: "User rejected the reply. Ask for guidance on the reply.";
		return { approved: false, reason };
	}

	return { approved: true };
}
