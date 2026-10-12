/**
 * History Guardian Extension
 *
 * Two guards over history-rewriting git commands. `history` reports a
 * rebase, stash drop or leased force push by default and asks first in
 * block mode. `history-destructive` refuses what cannot be undone, with
 * the safe form named, and leases a bare force push itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import { destructiveHistoryGuardian, riskyHistoryGuardian } from "./review.ts";

export default function historyGuardianExtension(pi: ExtensionAPI) {
	registerGuardian(pi, riskyHistoryGuardian, {
		declaration: GUARDS.history,
	});
	// A refusal needs nobody to read a panel, so it holds for headless
	// runs and subagents too.
	registerGuardian(pi, destructiveHistoryGuardian, {
		declaration: GUARDS.historyDestructive,
		enforceWithoutUI: true,
	});
}
