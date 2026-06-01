/**
 * Turns detected Slack content violations into a single
 * skill-grounded instruction the gate hands back to the author.
 * The message names each kind of problem and points at the
 * slack-guide skill so the retry is informed, not a guess.
 */

import type { SlackViolation } from "./detect.js";

/** Format Slack violations into a block message, or "" if none. */
export function formatSlackBlock(violations: SlackViolation[]): string {
	if (violations.length === 0) return "";

	const kinds = new Set(violations.map((v) => v.kind));
	const lines: string[] = [
		"This Slack message uses formatting that will not render the way",
		"you intended. Fix it and try again, per the slack-guide skill.",
		"",
	];

	if (kinds.has("slack-image")) {
		lines.push(
			"- Markdown image embeds (![alt](url)) do not render in Slack.",
			"  Upload the image with upload_file instead of embedding it.",
		);
	}

	if (kinds.has("slack-table")) {
		lines.push(
			"- A markdown pipe table will render as literal text. Send the",
			"  data through the structured table parameter instead.",
		);
	}

	if (kinds.has("slack-list")) {
		lines.push(
			"- A list is malformed and will render as plain text. Use a",
			"  bullet followed by a space (- item) or `N.` ordinals, per",
			"  the slack-guide skill.",
		);
	}

	return lines.join("\n");
}
