/**
 * Commit Guardian Extension
 *
 * Intercepts git commit commands and presents the commit
 * message for review before execution. Approve, edit, redirect,
 * or reject.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.js";
import { isGitBypassed } from "../../lib/internal/git/bypass.js";
import { createCommitGuardian } from "./review.js";

export default function commitGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, createCommitGuardian(pi), {
		name: "commit",
		bypass: isGitBypassed,
		enforceWithoutUI: true,
	});
}
