/** Shared review-quality standards for pr-workflow subagents. */

/**
 * Return the universal quality bar every review subprocess
 * applies before emitting, keeping or challenging findings.
 */
export function reviewQualityStandard(): string {
	return [
		"## Review quality standard",
		"Use this as the baseline review standard for application code, " +
			"infrastructure as code, configuration, migrations, generated assets " +
			"and technical docs. Local project and user skills specialize this " +
			"standard, but they don't excuse concrete correctness, security, " +
			"privacy, safety or operability risks.",
		"A finding matters when it identifies a concrete risk to behaviour, " +
			"correctness, security, privacy, permissions, data integrity, API or " +
			"backwards compatibility, reliability, observability, rollout safety, " +
			"cost, test confidence, future maintainability, reader understanding " +
			"or a local convention the project clearly relies on.",
		"Review changed behaviour, not just changed lines. Trace inputs, outputs, " +
			"control flow, callers, callees, ownership boundaries, failure paths, " +
			"boundary values, idempotency, concurrency, migrations, configuration, " +
			"docs and tests when they are relevant to the change.",
		"Verify assumptions with scoped inspection before flagging. If the " +
			"available context is insufficient, make uncertainty explicit and use a " +
			"question instead of presenting speculation as fact.",
		"Do not flag pure preference, generic cleanliness or alternative designs " +
			"unless they create real cognitive load, conflict with established local " +
			"patterns or plausibly increase future change risk.",
	].join("\n\n");
}

/**
 * Return the discovery objective for first-pass reviewers.
 */
export function reviewDiscoveryStandard(): string {
	return [
		"## Council discovery objective",
		"Optimize for high recall without spam. Surface material findings the " +
			"judge and user should consider, even if you're not certain they should " +
			"be posted. Do not emit notes that merely prove you read the diff.",
		"For each finding, explain why it matters to the author now. Prefer " +
			"specific evidence, affected scenarios and concrete next steps over broad " +
			"advice like 'add tests' or 'clean this up'.",
	].join("\n\n");
}

/**
 * Return the stack-specific discovery objective.
 */
export function stackReviewDiscoveryStandard(): string {
	return [
		reviewDiscoveryStandard(),
		"## Stack-specific discovery objective",
		"Look for sequencing problems, hidden dependencies between PRs, " +
			"inconsistent abstractions, repeated fixes, cumulative migration or " +
			"configuration risk, and docs/tests that only become misleading when " +
			"the stack is read together.",
		"Keep local findings under the PR where the author can act on them. Use " +
			"cross-PR findings only when the issue genuinely spans multiple PRs, " +
			"and choose the home PR where the comment is most actionable.",
	].join("\n\n");
}

/**
 * Return the curation objective for judge subprocesses.
 */
export function reviewSynthesisStandard(): string {
	return [
		"## Judge synthesis objective",
		"Optimize for a small, high-signal candidate review. Keep material risks, " +
			"merge duplicates, drop weak or taste-only findings, and preserve the " +
			"evidence and reviewer agreement that make a finding credible.",
		"Make severity and intent match the evidence. Downgrade speculative claims " +
			"to questions, upgrade understated concrete risks, and rewrite subjects " +
			"so they explain the author-visible impact rather than the implementation " +
			"detail alone.",
		"Only keep findings that you would be comfortable asking the user to post " +
			"after they review them. The final list should feel like an excellent " +
			"human review, not a transcript of every model observation.",
	].join("\n\n");
}

/**
 * Return the stack-specific curation objective.
 */
export function stackReviewSynthesisStandard(): string {
	return [
		reviewSynthesisStandard(),
		"## Stack-specific synthesis objective",
		"Preserve the stack topology. Do not move a finding between PRs unless " +
			"the evidence shows it belongs elsewhere, and do not duplicate the same " +
			"conceptual issue across every PR in the stack.",
		"A cross-PR finding should remain cross-PR only when the combined stack " +
			"is necessary to understand or act on the problem. Assign `homePrNumber` " +
			"to the PR where the author can most usefully respond.",
	].join("\n\n");
}

/**
 * Return the quality-control objective for critique subprocesses.
 */
export function reviewCritiqueStandard(): string {
	return [
		"## Critique quality-control objective",
		"Audit the judge's synthesis against the review quality standard. Look for " +
			"material risks the judge dropped, weak findings it kept, unlike findings " +
			"it over-merged, local conventions it ignored, evidence it lost, and " +
			"severity or certainty it misstated.",
		"Use `agree` when the finding is worth keeping as-is, `disagree` when it " +
			"should not survive, `qualify` when it needs narrower wording or lower " +
			"severity, and `amplify` when the evidence shows higher impact than the " +
			"judge expressed.",
		"Do not relitigate every preference from round 1. Focus on whether the " +
			"judge produced a review the user should trust.",
	].join("\n\n");
}
