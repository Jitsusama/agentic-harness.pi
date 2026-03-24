/**
 * Git CLI Interceptor Extension
 *
 * Enforces the git-cli-convention skill's "one concern per
 * bash call" rule by blocking compound commands that chain
 * multiple guardable targets or mix state changes with
 * guardable commands.
 *
 * Block messages direct the LLM to read the convention skill
 * and retry with separate bash calls. This ensures guardians
 * can process each command independently.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { detectCompoundViolation } from "./patterns.js";

export default function gitCliInterceptor(pi: ExtensionAPI) {
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			const command = event.input.command;
			const violation = detectCompoundViolation(command);
			if (violation) {
				return { block: true, reason: violation };
			}
		},
	);
}
