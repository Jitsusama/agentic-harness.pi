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
import { isGitBypassed } from "../../lib/internal/git/bypass.js";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/parse.js";
import {
	detectAmendViolation,
	detectCompoundViolation,
	detectUnquotedCommitHeredoc,
} from "./patterns.js";

export default function gitCliInterceptor(pi: ExtensionAPI) {
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;
			if (isGitBypassed()) return;

			const command = event.input.command;
			const stripped = stripShellData(stripHeredocBodies(command));

			const amend = detectAmendViolation(stripped);
			if (amend) return { block: true, reason: amend };

			// Heredoc check uses original command for the operator
			// and stripped for git commit scoping.
			const heredoc = detectUnquotedCommitHeredoc(stripped, command);
			if (heredoc) return { block: true, reason: heredoc };

			const compound = detectCompoundViolation(stripped);
			if (compound) return { block: true, reason: compound };
		},
	);
}
