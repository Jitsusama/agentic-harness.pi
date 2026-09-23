/**
 * History Guardian Extension
 *
 * Intercepts destructive or history-rewriting git commands
 * and requires confirmation before execution.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.ts";
import { isGitBypassed } from "../../lib/internal/git/bypass.ts";
import { historyGuardian } from "./review.ts";

export default function historyGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, historyGuardian, {
		name: "history",
		bypass: isGitBypassed,
	});
}
