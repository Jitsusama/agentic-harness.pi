/**
 * Git CLI Interceptor Extension
 *
 * Enforces the commit-format skill's "one concern per bash
 * call" rule by blocking compound commands that chain
 * multiple guardable targets or mix state changes with
 * guardable commands.
 *
 * Block messages state the corrective action rather than
 * naming a skill to read, so a retry needs nothing loaded.
 * This ensures guardians
 * can process each command independently.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { checkGitCli } from "@jitsusama/agentic-harness.core/git-cli";
import { isGitBypassed } from "../../lib/internal/git/bypass.js";

export default function gitCliInterceptor(pi: ExtensionAPI) {
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;
			if (isGitBypassed()) return;

			const reason = checkGitCli(event.input.command);
			if (reason) return { block: true, reason };
		},
	);
}
