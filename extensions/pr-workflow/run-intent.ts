/**
 * Per-run intent for a council, judge or critique round.
 *
 * The prompt addendum is the per-run channel: where a persona
 * charter is the standing lens, the addendum is the focus for this
 * one run — "look hardest at the auth changes", "be stricter this
 * pass", "the migration is the risky part". Two sources feed it: a
 * review-context provider (repository or platform context) and the
 * user's own intent. This module merges them into the single
 * addendum slot the rounds already understand.
 */

const INTENT_HEADING = "## This run";

/**
 * Merge the provider review context and the user's per-run intent
 * into one prompt addendum. Returns the provider context alone, the
 * intent alone (under a heading), both joined, or undefined when
 * neither is present so callers can omit the field entirely.
 */
export function composeRunAddendum(
	providerAddendum: string | undefined,
	userIntent: string | undefined,
): string | undefined {
	const provider = providerAddendum?.trim() ?? "";
	const intent = userIntent?.trim() ?? "";
	const parts: string[] = [];
	if (provider !== "") parts.push(provider);
	if (intent !== "") parts.push(`${INTENT_HEADING}\n\n${intent}`);
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}
