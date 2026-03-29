/**
 * PR command parsing: re-exports shared utilities from
 * lib/github/cli and adds the PR-specific rebuild helper.
 */

import { rebuildGhCommand } from "../../lib/internal/github/cli.js";

export {
	isPrCommand,
	type PrCommand,
	parsePrCommand,
} from "../../lib/internal/github/cli.js";

import type { PrCommand } from "../../lib/internal/github/cli.js";

const HEREDOC_DELIM = "__PR_BODY__";

/** Rebuild the command with an edited body. */
export function rebuildCommand(
	parsed: PrCommand,
	newBody: string,
	newTitle?: string,
): string {
	return rebuildGhCommand({
		entity: "pr",
		action: parsed.action,
		entityNumber: parsed.prNumber,
		prefix: parsed.prefix,
		extraFlags: parsed.extraFlags,
		title: newTitle ?? parsed.title,
		body: newBody,
		heredocDelim: HEREDOC_DELIM,
	});
}
