/**
 * Round 4 — user synthesis.
 *
 * The user reads the council pipeline output and takes
 * positions on findings. This module owns:
 *
 *   - the `FindingDecision` shape (one verdict per
 *     finding plus content needed by that verdict)
 *   - `decideFinding(state, input)` to record / revise
 *     a decision
 *   - `formatFindingsView(state)` to render the
 *     pipeline + decisions as a single read-only view
 *
 * Posting decisions to GitHub belongs in a later slice.
 * Promotion to a draft review body also belongs later;
 * the verdict alone records the user's position.
 */

import type { CritiquePosition } from "./critique.js";
import type { Finding, FindingLocation } from "./findings.js";
import type { PrWorkflowState } from "./state.js";

/**
 * The user's verdict on a single consolidated finding.
 * Discriminated union so each verdict carries only the
 * fields it actually needs.
 */
export type FindingDecision =
	| {
			readonly findingId: number;
			readonly verdict: "endorse";
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "qualify";
			readonly note: string;
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "edit";
			readonly subject?: string;
			readonly discussion?: string;
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "dismiss";
			readonly reason?: string;
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "promote";
			readonly decidedAt: string;
	  }
	| {
			readonly findingId: number;
			readonly verdict: "fix";
			readonly instructions?: string;
			readonly decidedAt: string;
			/**
			 * Set by `recordFixDone` after the user (or agent
			 * acting on their behalf) lands a commit that
			 * addresses this finding. Mutually exclusive with
			 * `skipped`.
			 */
			readonly resolvedBy?: {
				readonly commitSha: string;
				readonly recordedAt: string;
			};
			/**
			 * Set by `recordFixSkip` when the user decides not
			 * to land the queued fix after all. Mutually
			 * exclusive with `resolvedBy`.
			 */
			readonly skipped?: {
				readonly reason: string;
				readonly recordedAt: string;
			};
	  };

/** Result of a decision mutation. */
export type DecisionResult = { ok: true } | { ok: false; error: string };

/**
 * Which set of findings the decision targets. Defaults
 * to `"pr"` (the per-PR judge findings in
 * `state.council.lastJudge`). `"stack"` routes the
 * decision to `state.stackDecisions` against the most
 * recent `state.stackCritic` run.
 */
export type DecideFindingScope = "pr" | "stack";

type WithScope<T> = T & { readonly scope?: DecideFindingScope };

/** Inputs to `decideFinding`, without the timestamp. */
export type DecideFindingInput = WithScope<
	| { findingId: number; verdict: "endorse" }
	| { findingId: number; verdict: "qualify"; note: string }
	| {
			findingId: number;
			verdict: "edit";
			subject?: string;
			discussion?: string;
	  }
	| { findingId: number; verdict: "dismiss"; reason?: string }
	| { findingId: number; verdict: "promote" }
	| { findingId: number; verdict: "fix"; instructions?: string }
>;

/**
 * Record or overwrite the user's decision on one finding.
 * Validates the input shape (qualify needs a note; edit
 * needs subject and/or discussion) and that the finding
 * id exists in the most-recent judge run.
 */
export function decideFinding(
	state: PrWorkflowState,
	input: DecideFindingInput,
	now: () => Date = () => new Date(),
): DecisionResult {
	const scope: DecideFindingScope = input.scope ?? "pr";
	const lookup = lookupFinding(state, input.findingId, scope);
	if (!lookup.ok) return lookup;

	const validation = validateInput(input);
	if (!validation.ok) return validation;

	const decidedAt = now().toISOString();
	const decision: FindingDecision = buildDecision(input, decidedAt);
	if (scope === "stack") {
		state.stackDecisions.set(input.findingId, decision);
	} else {
		state.council.decisions.set(input.findingId, decision);
	}
	return { ok: true };
}

/**
 * Resolve a finding id against the scope-appropriate
 * source. Returns a failure result with a scope-specific
 * error when the source isn't populated or the id
 * doesn't exist.
 */
function lookupFinding(
	state: PrWorkflowState,
	findingId: number,
	scope: DecideFindingScope,
): DecisionResult {
	if (scope === "stack") {
		if (state.stackCritic === null) {
			return {
				ok: false,
				error:
					"No stack-critic run available. Run pr_workflow action=stack-critic first.",
			};
		}
		const exists = state.stackCritic.findings.some((f) => f.id === findingId);
		if (!exists) {
			return {
				ok: false,
				error: `Unknown stack findingId ${findingId}: not in the most-recent stack-critic run.`,
			};
		}
		return { ok: true };
	}
	const judge = state.council.lastJudge;
	if (judge === null) {
		return {
			ok: false,
			error:
				"No findings to decide on. Run pr_workflow action=council, then action=judge first.",
		};
	}
	const exists = judge.consolidatedFindings.some((f) => f.id === findingId);
	if (!exists) {
		return {
			ok: false,
			error: `Unknown findingId ${findingId}: not in the most-recent judge run.`,
		};
	}
	return { ok: true };
}

function validateInput(input: DecideFindingInput): DecisionResult {
	if (input.verdict === "qualify") {
		if (input.note.trim().length === 0) {
			return {
				ok: false,
				error:
					"qualify verdict requires a non-empty `note`. Say what to soften or qualify.",
			};
		}
	}
	if (input.verdict === "edit") {
		const subjectGiven =
			typeof input.subject === "string" && input.subject.trim().length > 0;
		const discussionGiven =
			typeof input.discussion === "string" &&
			input.discussion.trim().length > 0;
		if (!subjectGiven && !discussionGiven) {
			return {
				ok: false,
				error:
					"edit verdict requires at least one of `subject` or `discussion`.",
			};
		}
	}
	return { ok: true };
}

function buildDecision(
	input: DecideFindingInput,
	decidedAt: string,
): FindingDecision {
	switch (input.verdict) {
		case "endorse":
			return { findingId: input.findingId, verdict: "endorse", decidedAt };
		case "qualify":
			return {
				findingId: input.findingId,
				verdict: "qualify",
				note: input.note,
				decidedAt,
			};
		case "edit":
			return {
				findingId: input.findingId,
				verdict: "edit",
				subject: input.subject,
				discussion: input.discussion,
				decidedAt,
			};
		case "dismiss":
			return {
				findingId: input.findingId,
				verdict: "dismiss",
				reason: input.reason,
				decidedAt,
			};
		case "promote":
			return { findingId: input.findingId, verdict: "promote", decidedAt };
		case "fix":
			return {
				findingId: input.findingId,
				verdict: "fix",
				instructions: input.instructions,
				decidedAt,
			};
	}
}

/**
 * Render the user's view of the pipeline state: each
 * consolidated finding with its critique dissent and
 * current decision (or "pending"). The output is what
 * the agent surfaces during round-4 conversation.
 */
export function formatFindingsView(state: PrWorkflowState): string {
	const judge = state.council.lastJudge;
	if (judge === null) {
		return "No findings yet. Run pr_workflow action=council, then action=judge.";
	}
	if (judge.consolidatedFindings.length === 0 && state.stackCritic === null) {
		return "Judge consolidated 0 findings; nothing to decide on.";
	}
	const lines: string[] = [];
	for (const finding of judge.consolidatedFindings) {
		const decision = state.council.decisions.get(finding.id) ?? null;
		const display = applyEdit(finding, decision);
		lines.push(
			`[${finding.id}] [${finding.label}] ${display.subject} ${renderLocation(finding.location)}`,
		);
		const raisedBy = finding.agreement?.raisedBy ?? [];
		if (raisedBy.length > 0) {
			lines.push(`   raised by: ${raisedBy.join(", ")}`);
		}
		lines.push(`   ${display.discussion}`);
		const critiquesForFinding = collectCritiques(state, finding.id);
		for (const c of critiquesForFinding) {
			lines.push(
				`   critique [${c.reviewerId}]: ${c.position} — ${c.rationale}`,
			);
		}
		lines.push(`   decision: ${renderDecision(decision)}`);
		if (decision?.verdict === "edit") {
			lines.push(`     original subject: ${finding.subject}`);
			lines.push(`     original discussion: ${finding.discussion}`);
		}
		lines.push("");
	}
	if (state.stackCritic !== null && state.stackCritic.findings.length > 0) {
		lines.push("Stack-level findings (decide with scope=stack):");
		lines.push("");
		for (const finding of state.stackCritic.findings) {
			const decision = state.stackDecisions.get(finding.id) ?? null;
			const display = applyEdit(finding, decision);
			lines.push(
				`[S${finding.id}] [${finding.label}] ${display.subject} (home: #${finding.homePrNumber}; spans: ${finding.spans.join(", ")})`,
			);
			lines.push(`   ${display.discussion}`);
			lines.push(`   decision: ${renderDecision(decision)}`);
			if (decision?.verdict === "edit") {
				lines.push(`     original subject: ${finding.subject}`);
				lines.push(`     original discussion: ${finding.discussion}`);
			}
			lines.push("");
		}
	}
	return lines.join("\n").trimEnd();
}

function collectCritiques(
	state: PrWorkflowState,
	findingId: number,
): {
	reviewerId: string;
	position: CritiquePosition;
	rationale: string;
}[] {
	const critique = state.council.lastCritique;
	if (critique === null) return [];
	const out: {
		reviewerId: string;
		position: CritiquePosition;
		rationale: string;
	}[] = [];
	for (const output of critique.reviewerOutputs) {
		const entry = output.critiques.find((c) => c.findingId === findingId);
		if (entry) {
			out.push({
				reviewerId: entry.reviewerId,
				position: entry.position,
				rationale: entry.rationale,
			});
		}
	}
	return out;
}

function applyEdit(
	finding: Finding,
	decision: FindingDecision | null,
): { subject: string; discussion: string } {
	if (decision?.verdict === "edit") {
		return {
			subject: decision.subject ?? finding.subject,
			discussion: decision.discussion ?? finding.discussion,
		};
	}
	return { subject: finding.subject, discussion: finding.discussion };
}

function renderDecision(decision: FindingDecision | null): string {
	if (decision === null) return "pending";
	switch (decision.verdict) {
		case "endorse":
			return "endorse";
		case "qualify":
			return `qualify — ${decision.note}`;
		case "edit":
			return "edit (see overrides above)";
		case "dismiss":
			return decision.reason ? `dismiss — ${decision.reason}` : "dismiss";
		case "promote":
			return "promote";
		case "fix":
			if (decision.resolvedBy) {
				return `✓ fixed in ${decision.resolvedBy.commitSha}`;
			}
			if (decision.skipped) {
				return `fix skipped — ${decision.skipped.reason}`;
			}
			return decision.instructions
				? `queued for fix — ${decision.instructions}`
				: "queued for fix";
	}
}

function renderLocation(loc: FindingLocation): string {
	switch (loc.kind) {
		case "line":
			return `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}
