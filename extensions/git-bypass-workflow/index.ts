/**
 * Git Bypass Workflow Extension
 *
 * Registers a /git-intercept command that toggles git command
 * interception on and off within a session. Useful for
 * profiling git or other investigative work where the
 * interceptor and guardians get in the way.
 *
 * Writes to process-global state read by the git-cli-interceptor,
 * commit-guardian and history-guardian extensions. Works
 * independently: loading order doesn't matter, and each
 * extension can be loaded without the others.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	isGitBypassed,
	setGitBypassed,
} from "../../lib/internal/git/bypass.js";

const STATUS_KEY = "git-bypass-workflow";

export default function gitBypassWorkflow(pi: ExtensionAPI) {
	pi.registerCommand("git-intercept", {
		description: "Toggle git command interception on/off",
		handler: async (_args, ctx) => {
			const bypassed = !isGitBypassed();
			setGitBypassed(bypassed);

			const theme = ctx.ui.theme;
			if (bypassed) {
				ctx.ui.setStatus(
					STATUS_KEY,
					`${theme.fg("warning", "⚠")} ${theme.fg("muted", "Git Bypass")}`,
				);
				ctx.ui.notify("Git interception disabled", "info");
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Git interception enabled", "info");
			}
		},
	});
}
