/**
 * The always-on validation directive appended to the tool
 * output once the judge or stack review has consolidated
 * findings.
 *
 * The findings are unvalidated candidates from independent
 * reviewer subagents, which can be confidently wrong. The
 * judge is itself a subagent, so consolidation does not make
 * them true. Trust comes from the main agent reading the real
 * source and collapsing the list itself, so the directive
 * leads the agent into that pass rather than handing over a
 * decide-ready list.
 */
export function reviewValidationDirective(): string {
	return [
		"Before you present these findings:",
		"",
		"These are unvalidated candidates from independent reviewer subagents, which can be confidently wrong. Do not relay them as-is. Before showing anything to the user, run a validation pass:",
		"",
		"1. Validate each finding against the real source. Open the cited files and lines, confirm the risk is real, and drop anything you cannot substantiate.",
		"2. Collapse duplicate and near-duplicate findings into one.",
		"3. Group what survives by root cause, so related findings are addressed together rather than one symptom at a time.",
		"4. Restate the survivors as clear, author-facing direction.",
		"",
		"Then present the validated, deduplicated, root-caused set, and say what you dropped and why.",
	].join("\n");
}
