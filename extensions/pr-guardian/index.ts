/**
 * PR Guardian Extension
 *
 * Gates gh pr create and gh pr edit commands. The host, section,
 * title and prose redirects refuse what needs fixing; the PR itself
 * is reported in the transcript by default, or shown for review
 * before execution in block mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { createPrGuardian } from "./review.ts";

export default function prGuardianExtension(pi: ExtensionAPI) {
	declareGuards(GUARDS.host, GUARDS.sections, GUARDS.titles, GUARDS.prose);
	registerGuardian(pi, createPrGuardian(pi), {
		declaration: GUARDS.pr,
		enforceWithoutUI: true,
	});
}
