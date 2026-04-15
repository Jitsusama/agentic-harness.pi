/**
 * GitHub CLI Interceptor Extension
 *
 * Enforces the github-cli-convention skill's formatting rules
 * by blocking gh pr/issue commands that use inline --body
 * instead of heredoc, or pack metadata flags into create
 * commands.
 *
 * Block messages direct the LLM to read the convention skill
 * and retry with the correct format.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/parse.js";
import { detectInlineBody, detectPackedMetadata } from "./patterns.js";

export default function githubCliInterceptor(pi: ExtensionAPI) {
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			const stripped = stripShellData(stripHeredocBodies(event.input.command));
			const violation =
				detectInlineBody(stripped) ?? detectPackedMetadata(stripped);
			if (violation) {
				return { block: true, reason: violation };
			}
		},
	);
}
