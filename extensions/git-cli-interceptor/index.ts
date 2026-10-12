/**
 * Git CLI Interceptor Extension
 *
 * Two guards, because the rules here protect different things.
 *
 * `commit-shape` refuses an amend and a commit heredoc with an
 * unquoted delimiter. Both are redirects: there is a right form to
 * retry with (a new commit, a quoted delimiter), so they block by
 * default whatever the approvals do.
 *
 * `git-cli` enforces the commit-format skill's "one concern per bash
 * call" rule, which exists so each review panel sees one command. It
 * follows the commit, pr and issue guards: while all of them report
 * there is no panel to protect, and the chain runs with a report.
 * Once any of them blocks, the chain is refused as before.
 *
 * Block messages state the corrective action rather than naming a
 * skill to read, so a retry needs nothing loaded.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	detectAmendViolation,
	detectCompoundViolation,
	detectUnquotedCommitHeredoc,
} from "@jitsusama/agentic-harness.core/git-cli";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import type { GuardianBlock } from "../../lib/guardian/index.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/index.ts";

/** A reason as the refusal the policy applies its mode to. */
function refusal(reason: string | null): GuardianBlock | undefined {
	return reason ? { block: true, reason } : undefined;
}

export default function gitCliInterceptor(pi: ExtensionAPI) {
	declareGuards(GUARDS.commitShape, GUARDS.gitCli);
	pi.on(
		"tool_call",
		async (event): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			const command = event.input.command;
			const stripped = stripShellData(stripHeredocBodies(command));
			const shape =
				detectAmendViolation(stripped) ??
				detectUnquotedCommitHeredoc(stripped, command);
			const shaped = refusalUnder(
				GUARDS.commitShape.name,
				refusal(shape),
				"Commit shape",
			);
			if (shaped) return shaped;
			return refusalUnder(
				GUARDS.gitCli.name,
				refusal(detectCompoundViolation(stripped)),
				"Chained guardable commands",
			);
		},
	);
}
