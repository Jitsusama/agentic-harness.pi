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
} from "@mariozechner/pi-coding-agent";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/parse.js";
import {
	detectBodyFilePath,
	detectInlineBody,
	detectMissingHeredoc,
	detectPackedMetadata,
	detectUnsafeHeredoc,
} from "./patterns.js";

export default function githubCliInterceptor(pi: ExtensionAPI) {
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			const command = event.input.command;
			const stripped = stripShellData(stripHeredocBodies(command));

			// Checks on the stripped command (heredoc bodies and
			// non-executable content removed).
			const strippedViolation =
				detectInlineBody(stripped) ??
				detectPackedMetadata(stripped) ??
				detectBodyFilePath(stripped) ??
				detectMissingHeredoc(stripped, command);
			if (strippedViolation) {
				return { block: true, reason: strippedViolation };
			}

			// The unquoted heredoc check runs on the original
			// command because it validates the heredoc operator
			// itself, which stripping would remove.
			const heredocViolation = detectUnsafeHeredoc(stripped, command);
			if (heredocViolation) {
				return { block: true, reason: heredocViolation };
			}
		},
	);
}
