/**
 * Git Guardian Extension
 *
 * Safety net for git operations:
 *   1. Commit review — approve, edit, steer, or reject
 *   2. Destructive command protection — confirm before danger
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { DESTRUCTIVE_PATTERNS } from "./patterns.js";
import { reviewCommit } from "./review.js";
import { confirmDestructive } from "./destructive.js";

export default function gitGuardian(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!ctx.hasUI) return;

		const command = event.input.command;

		if (/\bgit\s+commit\b/.test(command)) {
			return reviewCommit(event, ctx);
		}

		for (const { pattern, severity, description } of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(command)) {
				return confirmDestructive(command, severity, description, ctx);
			}
		}
	});
}
