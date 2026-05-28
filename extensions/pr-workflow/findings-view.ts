/**
 * Compact view of the loaded PR's findings.
 *
 * `formatFindingsView` (in synthesis.ts) is the
 * wall-of-text variant kept for the rare case where
 * the user wants every detail in one dump. This module
 * is the default round-4 surface: one row per finding,
 * verdict marker, subject and location only.
 *
 * Re-orientation cost was high in Phase 4 of testing —
 * the user had to scroll past hundreds of lines to find
 * a finding they had already decided. The compact view
 * trades expanded detail for a glance-friendly index;
 * `findings verbose:true` is always available when the
 * full text matters.
 */

import type { DiffFile } from "../../lib/internal/github/diff.js";
import type { CritiqueRun } from "./critique.js";
import type { Finding } from "./findings.js";
import { hasValidInlineAnchor } from "./post.js";
import type { PrWorkflowState } from "./state.js";
import { effectiveFinding, type FindingDecision } from "./synthesis.js";
import { renderThreadRelation } from "./thread-context.js";

/**
 * One-character verdict marker for a decision.
 *
 * `·` (pending) is rendered when the user hasn't
 * recorded a verdict yet. Fix decisions encode their
 * resolution state (queued / committed / skipped) into
 * the marker so the queue is visible at a glance.
 */
export function verdictMarker(decision: FindingDecision | null): string {
	if (decision === null) return "·";
	switch (decision.verdict) {
		case "endorse":
			return "+";
		case "qualify":
			return "?";
		case "edit":
			return "~";
		case "dismiss":
			return "-";
		case "promote":
			return "^";
		case "fix":
			if (decision.resolvedBy) return "✓";
			if (decision.skipped) return "—";
			return "*";
	}
}

function renderLocation(finding: Finding): string {
	const loc = finding.location;
	switch (loc.kind) {
		case "line":
			return `${loc.file}:${loc.start}-${loc.end}`;
		case "file":
			return loc.file;
		case "global":
			return "scope";
	}
}

/**
 * Compact one-glance critique summary next to a judge
 * finding. Shows `crit: 3 agree, 1 disagree` style so the
 * user knows the round-3 roster pushed back without
 * jumping to `verbose:true`. Suppresses entries where
 * everyone agrees (the default; no value in restating).
 */
function renderCritiqueSummary(
	critique: CritiqueRun | null,
	findingId: number,
): string {
	if (critique === null) return "";
	// Count at most one position per reviewer so a roster
	// that emits two critique entries for the same finding
	// (uncommon but not schema-forbidden) doesn't inflate
	// the "3 agree" line. The reviewer's first position on
	// this finding wins.
	const seen = new Map<string, "agree" | "disagree" | "qualify" | "amplify">();
	for (const output of critique.reviewerOutputs) {
		for (const entry of output.critiques) {
			if (entry.findingId !== findingId) continue;
			if (seen.has(output.reviewerId)) continue;
			seen.set(output.reviewerId, entry.position);
		}
	}
	const counts = { agree: 0, disagree: 0, qualify: 0, amplify: 0 };
	for (const position of seen.values()) counts[position]++;
	const nonAgree = counts.disagree + counts.qualify + counts.amplify;
	if (nonAgree === 0) return "";
	const parts: string[] = [];
	if (counts.agree > 0) parts.push(`${counts.agree} agree`);
	if (counts.disagree > 0) parts.push(`${counts.disagree} disagree`);
	if (counts.qualify > 0) parts.push(`${counts.qualify} qualify`);
	if (counts.amplify > 0) parts.push(`${counts.amplify} amplify`);
	return ` · crit: ${parts.join(", ")}`;
}

/**
 * Render the fix-skip reason inline when the finding
 * was abandoned. The reason already lives on the
 * decision (`fix-skip` requires it) but the compact view
 * doesn't surface it; users see the `—` marker and have
 * to dig through `verbose:true` to learn why. Render
 * `— note: <reason>` after the location so the
 * abandoned-fix audit trail is in one place.
 */
function renderSkipReason(decision: FindingDecision | null): string {
	if (decision === null) return "";
	if (decision.verdict !== "fix") return "";
	if (!decision.skipped) return "";
	const reason = decision.skipped.reason.trim();
	if (reason.length === 0) return "";
	return ` — note: ${reason}`;
}

/**
 * Render `(→body)` when a line-kind finding's anchor
 * won't match the loaded PR diff at post time. Returns
 * an empty string for findings that anchor cleanly, for
 * non-line findings (already body-bound by nature), and
 * when the diff isn't loaded (we can't know yet).
 */
function renderBodyBoundMarker(
	finding: Finding,
	diffFiles: readonly DiffFile[] | null,
): string {
	if (finding.location.kind !== "line") return "";
	if (diffFiles === null || diffFiles.length === 0) return "";
	return hasValidInlineAnchor(finding.location, diffFiles) ? "" : " (→body)";
}

/**
 * Render the compact one-row-per-finding view of the
 * round-4 surface.
 *
 * Returns one row per judge finding plus, when present,
 * a cross-PR section. Pre-flight messages (no judge
 * run, empty consolidated set) match the wall-of-text
 * variant so callers can swap modes without breaking
 * the agent's interpretation.
 */
export function formatCompactFindingsView(state: PrWorkflowState): string {
	const judge = state.council.lastJudge;
	if (judge === null) {
		return "No findings yet. Run pr_workflow action=council, then action=judge.";
	}
	if (
		judge.consolidatedFindings.length === 0 &&
		state.stackFindingRun === null
	) {
		return "Judge consolidated 0 findings; nothing to decide on.";
	}

	const lines: string[] = [];
	lines.push(
		"Legend: · pending  + endorse  ? qualify  ~ edit  - dismiss  ^ promote  * fix-queued  ✓ fix-done  — fix-skipped",
	);
	lines.push(
		"Call `action=findings verbose:true` for the full discussion text.",
	);
	lines.push("");

	const diffFiles = state.pr?.files ?? null;

	for (const finding of judge.consolidatedFindings) {
		const decision = state.council.decisions.get(finding.id) ?? null;
		const projected = effectiveFinding(finding, decision);
		const { subject, label } = projected;
		const relation = renderThreadRelation(finding.threadRelation);
		const thread = relation === null ? "" : ` · ${relation}`;
		const bodyBound = renderBodyBoundMarker(projected, diffFiles);
		const critique = renderCritiqueSummary(
			state.council.lastCritique,
			finding.id,
		);
		const skipReason = renderSkipReason(decision);
		lines.push(
			`[${finding.id}] ${verdictMarker(decision)} [${label}] ${subject} (${renderLocation(projected)})${thread}${bodyBound}${critique}${skipReason}`,
		);
	}

	if (
		state.stackFindingRun !== null &&
		state.stackFindingRun.findings.length > 0
	) {
		lines.push("");
		lines.push("Stack-level findings (decide with scope=stack):");
		for (const finding of state.stackFindingRun.findings) {
			const decision = state.stackDecisions.get(finding.id) ?? null;
			const { subject, label } = effectiveFinding(finding, decision);
			lines.push(
				`[S${finding.id}] ${verdictMarker(decision)} [${label}] ${subject} (home: #${finding.homePrNumber})`,
			);
		}
	}

	return lines.join("\n");
}
