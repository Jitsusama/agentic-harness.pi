/**
 * Commit Guardian Extension
 *
 * Intercepts git commit commands and presents the commit
 * message for review before execution. Approve, edit, redirect,
 * or reject.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGuardian } from "../../lib/internal/guardian/register.js";
import { commitGuardian } from "./review.js";

export default function commitGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, commitGuardian);
}
