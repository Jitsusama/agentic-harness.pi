/**
 * Issue Guardian Extension
 *
 * Gates gh issue create and gh issue edit commands. The section,
 * title and prose redirects refuse what needs fixing; the issue itself
 * is reported in the transcript by default, or shown for review
 * before execution in block mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { createIssueGuardian } from "./review.ts";

export default function issueGuardianExtension(pi: ExtensionAPI) {
	declareGuards(GUARDS.sections, GUARDS.titles, GUARDS.prose);
	registerGuardian(pi, createIssueGuardian(pi), {
		declaration: GUARDS.issue,
		enforceWithoutUI: true,
	});
}
