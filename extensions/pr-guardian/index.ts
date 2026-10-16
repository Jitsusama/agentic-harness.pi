/**
 * PR Guardian Extension
 *
 * Gates gh pr create and gh pr edit commands. The host, section,
 * title and prose redirects refuse what needs fixing; the PR itself
 * is reported in the transcript by default, or shown for review
 * before execution in block mode.
 *
 * After a command has published a description, the audit reads it
 * and tells the model to fix one outside its shape, so the format
 * holds even where the gate was told only to report.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { auditPublished, PR_AUDIT_MESSAGE } from "./audit.ts";
import { createPrGuardian } from "./review.ts";

export default function prGuardianExtension(pi: ExtensionAPI) {
	declareGuards(GUARDS.host, GUARDS.sections, GUARDS.titles, GUARDS.prose);
	registerGuardian(pi, createPrGuardian(pi), {
		declaration: GUARDS.pr,
		enforceWithoutUI: true,
	});

	// Per session: the same description is never audited twice.
	const said = new Set<string>();
	pi.on("session_start", () => said.clear());
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || event.isError) return;
		const command = event.input.command;
		if (typeof command !== "string") return;
		const audit = auditPublished(command, said);
		if (!audit) return;
		said.add(audit.signature);
		// A follow-up with no triggerTurn joins the run's own queue, so the
		// model fixes the description before it yields, under the prompt
		// the run already has.
		pi.sendMessage(
			{ customType: PR_AUDIT_MESSAGE, content: audit.message, display: true },
			{ deliverAs: "followUp" },
		);
	});
}
