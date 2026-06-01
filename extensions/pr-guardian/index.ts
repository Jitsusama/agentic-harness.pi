/**
 * PR Guardian Extension
 *
 * Gates gh pr create and gh pr edit commands, showing the
 * formatted PR description for user review before execution.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.js";
import { createPrGuardian } from "./review.js";

export default function prGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, createPrGuardian(pi), {
		name: "pr",
		enforceWithoutUI: true,
	});
}
