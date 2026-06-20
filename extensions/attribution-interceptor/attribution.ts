/**
 * Attribution injection for gh pr and issue bodies: splices an AI
 * co-authorship footer into the body in place. Commits are
 * attributed by the prepare-commit-msg hook, not here, so this
 * module no longer reconstructs a git commit command.
 */

import {
	type GhFooterInsertion,
	insertGhBodyFooter,
} from "../../lib/internal/github/attribution-edit.js";
import { formatModelName } from "../../lib/internal/guardian/commit-trailer.js";

/** Regex to detect existing attribution (case-insensitive). */
const ATTRIBUTION_PATTERN = /co-authored-by[:\s]+ai/i;

/** Build the markdown footer for PRs and issues. */
function ghFooter(modelId: string | null): string {
	const modelPart = modelId ? ` (${formatModelName(modelId)})` : "";
	// We need the double newline before --- so GitHub doesn't
	// treat the preceding paragraph as a setext h2 heading.
	return `\n\n---\n*Co-Authored-By AI${modelPart} via [Pi](https://github.com/badlogic/pi-mono)*`;
}

/**
 * Attribute a gh pr or gh issue command by splicing the footer into
 * its body in place, so the working directory, environment and
 * every other flag survive untouched. Returns a rewritten, blocked
 * or skip verdict; the caller fails closed on a blocked command so
 * a gh entity command in an unsupported shape never runs
 * un-attributed.
 */
export function attributeGh(
	command: string,
	entity: "pr" | "issue",
	modelId: string | null,
): GhFooterInsertion {
	return insertGhBodyFooter(command, entity, ghFooter(modelId), (body) =>
		ATTRIBUTION_PATTERN.test(body),
	);
}
