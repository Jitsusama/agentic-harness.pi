/**
 * Commit Guardian Extension
 *
 * Intercepts git commit commands and presents the commit
 * message for review before execution. Approve, edit, steer,
 * or reject.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { reviewCommit } from "./review.js";

export default function commitGuardian(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!ctx.hasUI) return;

		const command = event.input.command;

		if (/\bgit\s+commit\b/.test(command)) {
			return reviewCommit(event, ctx);
		}
	});
}
