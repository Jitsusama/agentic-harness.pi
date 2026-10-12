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
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";

export default function githubCliInterceptor(pi: ExtensionAPI) {
	declareGuards(GUARDS.githubCli);
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			const reason = checkGithubCli(event.input.command);
			return refusalUnder(
				GUARDS.githubCli.name,
				reason ? { block: true, reason } : undefined,
				"gh command shape",
			);
		},
	);
}
