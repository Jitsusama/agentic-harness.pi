/**
 * History Guardian Extension
 *
 * Intercepts destructive or history-rewriting git commands
 * and requires confirmation before execution.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.js";
import { historyGuardian } from "./review.js";

export default function historyGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, historyGuardian);
}
