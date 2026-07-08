/**
 * Convention Context Extension
 *
 * Injects a compact, resident reminder of the authoring
 * conventions into the system prompt at the start of every turn,
 * so the AI gets a PR, issue, commit, review comment or Slack
 * message right the first time and the gates have less to block.
 *
 * The reminder rides the resident prompt coordinator (a
 * contributor at the top of the order) and so is resident and
 * compaction-immune: it survives the context eviction that drops
 * a skill body mid-session, which is the eviction the gates exist
 * to backstop. The gates still enforce regardless of cwd; this is
 * the always-on baseline that reduces how often they have to
 * fire, not the enforcement itself.
 *
 * The block is injected only inside a git work tree, where PR,
 * commit, issue and Slack authoring actually happens, so an
 * unrelated cwd does not pay the token cost.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPromptContributor } from "../../lib/prompt/index.js";
import { buildBindingRules } from "./rules.js";
import { isInsideWorkTree } from "./scope.js";

/** Conventions sit at the very top of the resident block. */
const CONVENTIONS_ORDER = 0;

export default function conventionContext(pi: ExtensionAPI) {
	// Wrap pi.exec so it stays bound to pi when passed by reference.
	const exec = (command: string, args: string[], options?: { cwd?: string }) =>
		pi.exec(command, args, options);

	// The block is contributed only inside a git work tree, where
	// PR, commit, issue and Slack authoring actually happens, so an
	// unrelated cwd does not pay the token cost.
	registerPromptContributor({
		id: "convention-context",
		order: CONVENTIONS_ORDER,
		async contribute(ctx) {
			if (!(await isInsideWorkTree(exec, ctx.cwd))) return undefined;
			return buildBindingRules();
		},
	});
}
