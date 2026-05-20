/**
 * Suggest the next action after a `load`.
 *
 * The agent's trajectory rules in SKILL.md depend on
 * the user's prose ("review pr N", "let me see #N",
 * etc). Those rules are advisory and Phase 2 testing
 * showed they sometimes read as suggestions rather
 * than decisions.
 *
 * This module turns state-observable signals into a
 * short ranked list of next-action hints. The agent
 * still names the trajectory; this just removes the
 * "what do I call next?" friction.
 */

import type { PrWorkflowState } from "./state.js";

export interface LoadSuggestion {
	/** Tool action to call (e.g. "threads", "council-config"). */
	readonly action: string;
	/** One-sentence rationale displayed in the load output. */
	readonly rationale: string;
}

/**
 * Build a ranked list of next-action hints based on the
 * post-load state. Returns up to three items; callers
 * render them as a `Next:` block in the load summary
 * and ship the structured form in `details.suggestedNext`.
 *
 * Ranking rules (top-down):
 *
 * 1. **No roster configured** → `council-config` first.
 *    A fresh load can't run a council, so the highest
 *    leverage is configuring one.
 * 2. **Roster configured, no judge** → `council`. The
 *    user is one call away from a full review.
 * 3. **Judge has consolidated findings with pending
 *    decisions** → `findings`. The user is in the
 *    middle of Round 4.
 * 4. **Stack with siblings** → `stack-critic` as a
 *    secondary hint regardless of state above.
 *
 * `threads` always rides as a fallback when no other
 * hint applies: it's the cheapest "what's already
 * happening on this PR" probe.
 */
export function suggestNextAfterLoad(state: PrWorkflowState): LoadSuggestion[] {
	if (state.pr === null) return [];

	const hints: LoadSuggestion[] = [];
	const council = state.council;
	const stack = state.pr.stack;

	const judge = council.lastJudge;
	if (judge !== null && judge.consolidatedFindings.length > 0) {
		const pending = judge.consolidatedFindings.filter(
			(f) => !council.decisions.has(f.id),
		).length;
		if (pending > 0) {
			hints.push({
				action: "findings",
				rationale: `Resume Round 4: ${pending} of ${judge.consolidatedFindings.length} findings still pending a decision.`,
			});
		}
	}

	if (hints.length === 0) {
		if (council.roster.length === 0) {
			hints.push({
				action: "council-config",
				rationale:
					"No reviewer roster yet. Configure one before running a council.",
			});
		} else if (judge === null) {
			hints.push({
				action: "council",
				rationale: `Roster is configured (${council.roster.length} reviewers). Run the council on this PR.`,
			});
		}
	}

	if (stack !== null && stack.entries.length > 1) {
		hints.push({
			action: "stack-critic",
			rationale: `This PR is part of a ${stack.entries.length}-PR stack; a stack-critic run can spot cross-PR risks.`,
		});
	}

	hints.push({
		action: "threads",
		rationale: "Check for existing review feedback on this PR.",
	});

	return hints.slice(0, 3);
}

/**
 * Format the suggestions as text lines for the load
 * output. Returns an empty array when there are no
 * suggestions so the caller can splice the result in
 * unconditionally.
 */
export function formatLoadSuggestions(
	suggestions: readonly LoadSuggestion[],
): string[] {
	if (suggestions.length === 0) return [];
	const lines: string[] = ["", "Next:"];
	for (const hint of suggestions) {
		lines.push(`  • action=${hint.action} — ${hint.rationale}`);
	}
	return lines;
}
