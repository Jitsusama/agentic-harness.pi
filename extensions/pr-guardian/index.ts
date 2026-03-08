/**
 * PR Guardian Extension
 *
 * Gates gh pr create and gh pr edit commands, showing the
 * formatted PR description for user review before execution.
 * Follows the same approve/edit/steer/reject flow as the
 * commit review gate.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { isPrCommand, parsePrCommand } from "./parse.js";
import { reviewPr } from "./review.js";

export default function prGuardian(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!ctx.hasUI) return;

		const command = event.input.command;
		if (!isPrCommand(command)) return;

		const parsed = parsePrCommand(command);
		if (!parsed) return; // no body to review

		return reviewPr(event, parsed, ctx);
	});
}
