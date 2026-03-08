/**
 * Issue Guardian Extension
 *
 * Gates gh issue create and gh issue edit commands, showing the
 * formatted issue description for user review before execution.
 * Follows the same approve/edit/steer/reject flow as the
 * PR and commit review gates.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { isIssueCommand, parseIssueCommand } from "./parse.js";
import { reviewIssue } from "./review.js";

export default function issueGuardian(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!ctx.hasUI) return;

		const command = event.input.command;
		if (!isIssueCommand(command)) return;

		const parsed = parseIssueCommand(command);
		if (!parsed) return; // no body to review

		return reviewIssue(event, parsed, ctx);
	});
}
