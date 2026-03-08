/**
 * History Guardian Extension
 *
 * Intercepts destructive or history-rewriting git commands
 * and requires confirmation before execution. Protects
 * against force-push, hard reset, rebase, clean, and other
 * operations that can lose work.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { DESTRUCTIVE_PATTERNS } from "./patterns.js";
import { confirmDestructive } from "./confirm.js";

export default function historyGuardian(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!ctx.hasUI) return;

		const command = event.input.command;

		for (const { pattern, severity, description } of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(command)) {
				return confirmDestructive(command, severity, description, ctx);
			}
		}
	});
}
