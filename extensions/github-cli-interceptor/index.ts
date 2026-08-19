/**
 * GitHub CLI Interceptor Extension
 *
 * Enforces the github-cli-convention skill's formatting rules
 * for gh pr/issue commands: requires `--body-file -` with a
 * quoted heredoc for body content, and metadata assignment in
 * separate commands after creation.
 *
 * Block messages direct the LLM to read the convention skill
 * and retry with the correct format.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { checkGithubCli } from "@jitsusama/agentic-harness.core/github-cli";

export default function githubCliInterceptor(pi: ExtensionAPI) {
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			const reason = checkGithubCli(event.input.command);
			if (reason) return { block: true, reason };
		},
	);
}
