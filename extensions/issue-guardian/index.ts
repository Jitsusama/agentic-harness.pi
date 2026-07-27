/**
 * Issue Guardian Extension
 *
 * Gates gh issue create and gh issue edit commands, showing the
 * formatted issue description for user review before execution.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.js";
import { createIssueGuardian } from "./review.js";

export default function issueGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, createIssueGuardian(pi), {
		name: "issue",
		enforceWithoutUI: true,
	});
}
