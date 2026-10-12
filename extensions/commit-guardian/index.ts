/**
 * Commit Guardian Extension
 *
 * Intercepts git commit commands. By default it reports the commit
 * message, with its validation marks, in the transcript and lets the
 * commit run; in block mode it presents the message for review first.
 * Approve, edit, redirect, or reject.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardian } from "../../lib/guardian/register.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { createCommitGuardian } from "./review.ts";

export default function commitGuardianExtension(pi: ExtensionAPI) {
	declareGuards(GUARDS.commitVerification, GUARDS.prose);
	registerGuardian(pi, createCommitGuardian(pi), {
		declaration: GUARDS.commit,
		enforceWithoutUI: true,
	});
}
