/**
 * Render captured rules as a resident prompt block.
 *
 * The block rides the prompt coordinator every turn, so it is
 * kept compact: a short heading, a one-line framing and the rule
 * texts as a list. An empty store contributes nothing.
 */

import type { GovernanceRule } from "./types.js";

/**
 * Build the captured-lessons prompt block, or undefined when
 * there are no rules to contribute.
 */
export function renderRulesBlock(rules: GovernanceRule[]): string | undefined {
	if (rules.length === 0) return undefined;
	return [
		"## Learned Conventions (Captured From Past Corrections)",
		"",
		"These rules were distilled from corrections in earlier sessions.",
		"Follow them as standing guidance:",
		"",
		...rules.map((r) => `- ${r.text}`),
	].join("\n");
}
