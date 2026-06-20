/**
 * Attribution Interceptor Extension
 *
 * Injects AI co-authorship attribution into commits, PRs, and
 * issues created through Pi. Makes AI involvement transparent
 * for analytics tooling.
 *
 * Runs before guardians (alphabetical load order), so the user
 * sees the injected attribution during review. Returns undefined
 * to let subsequent handlers proceed with the modified command.
 *
 * Runs whether or not there is a UI. Attribution is a silent
 * command rewrite with no panel, like the other interceptors,
 * and transparency matters most in the headless and subagent
 * runs nobody is watching. The rewrite is idempotent, so a
 * command that already carries attribution is left alone.
 *
 * This extension mutates `event.input.command` directly rather
 * than going through `registerGuardian`, because interceptors
 * are a sanctioned mutation site for silent command enrichment
 * (see AGENTS.md "One Mutation Site for Command Rewriting").
 *
 * Attribution is unconditional: there is no opt-out flag. A gh
 * entity command in a shape we cannot parse well enough to
 * attribute is blocked, with a reason that asks the agent to
 * reissue it in a simpler form, rather than allowed to run
 * un-attributed.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { effectiveCwd, tokenize } from "../../lib/command/index.js";
import { ensureCommitHook } from "../../lib/internal/guardian/commit-hook.js";
import { coAuthorTrailer } from "../../lib/internal/guardian/commit-trailer.js";
import { attributeGh } from "./attribution.js";

const GH_ENTITIES = ["pr", "issue"] as const;

export default function attributionExtension(pi: ExtensionAPI) {
	// The prepare-commit-msg hook is how every commit path pi cannot
	// intercept at the command (cherry-pick, revert, rebase, merge,
	// editor) gets attributed. Install it once per repo the session
	// touches, so coverage follows the agent as it cds between repos
	// rather than only the repo pi started in.
	const hookedRepos = new Set<string>();
	ensureCommitHook(process.cwd(), hookedRepos);

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			const command = event.input.command;
			const modelId = ctx.model?.id ?? null;

			// Make sure the hook covers the repo this command runs in,
			// which may be one the agent cd'd into after startup.
			const cwd = effectiveCwd(tokenize(command), process.cwd());
			ensureCommitHook("dir" in cwd ? cwd.dir : process.cwd(), hookedRepos);

			// Carry the trailer to child git processes so the
			// prepare-commit-msg hook attributes every commit path,
			// typed or not, with the current model. The hook, not a
			// command rewrite, is the sole commit attribution path, so
			// the full command (cd, env, flags, chained commands) is
			// never reconstructed. PRs and issues splice their footer.
			process.env.PI_CO_AUTHOR = coAuthorTrailer(modelId);

			for (const entity of GH_ENTITIES) {
				const result = attributeGh(command, entity, modelId);
				if (result.kind === "rewritten") {
					(event.input as { command: string }).command = result.command;
					return;
				}
				if (result.kind === "blocked") {
					return {
						block: true,
						reason: `Attribution cannot be applied to this gh ${entity} command: ${result.reason}. Reissue it in a simple form, without wrapping it in command substitution, a subshell or a pipe, so it can be reviewed and attributed.`,
					};
				}
			}
		},
	);
}
