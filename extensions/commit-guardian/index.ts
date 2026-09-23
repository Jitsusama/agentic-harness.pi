/**
 * Commit Guardian Extension
 *
 * Intercepts git commit commands and presents the commit
 * message for review before execution. Approve, edit, redirect,
 * or reject.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.ts";
import { isGitBypassed } from "../../lib/internal/git/bypass.ts";
import { createCommitGuardian } from "./review.ts";

export default function commitGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, createCommitGuardian(pi), {
		name: "commit",
		bypass: isGitBypassed,
		enforceWithoutUI: true,
	});
}
